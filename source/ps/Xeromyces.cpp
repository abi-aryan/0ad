// $Id: Xeromyces.cpp,v 1.2 2004/07/09 19:59:19 janwas Exp $

#include "precompiled.h"

#include <vector>
#include <set>
#include <map>
#include <stack>

#include "ps/Xeromyces.h"
#include "ps/CLogger.h"
#include "lib/res/file.h"

// Because I (and Xerces) don't like these being redefined by wposix.h:
#ifdef HAVE_PCH
# undef read
# undef write
#endif

#include "XML.h"

// For Xerces headers:
#ifdef HAVE_DEBUGALLOC
# undef new
#endif

// The converter uses SAX2, so it should [theoretically]
// be fairly easy to swap Xerces for something else (if desired)
#include <xercesc/sax2/XMLReaderFactory.hpp>
#include <xercesc/sax2/DefaultHandler.hpp>

// Reenable better memory-leak messages
#ifdef HAVE_DEBUGALLOC
# define new new(_NORMAL_BLOCK, __FILE__, __LINE__)
#endif


int CXeromyces::XercesLoaded = 0; // for once-only initialisation


// Slightly nasty fwrite/fseek/ftell style thing
class membuffer
{
public:
	membuffer()
	{
		buffer = (char*)malloc(bufferinc);
		assert(buffer);
		allocated = bufferinc;
		length = 0;
	}

	~membuffer()
	{
		free(buffer);
	}

	void write(void* data, int size)
	{
		while (length + size >= allocated) grow();
		memcpy(&buffer[length], data, size);
		length += size;
	}

	void write(void* data, int size, int offset)
	{
		assert(offset >= 0 && offset+size <= length);
		memcpy(&buffer[offset], data, size);
	}

	int tell()
	{
		return length;
	}

	char* steal_buffer()
	{
		char* ret = buffer;
		buffer = NULL;
		return ret;
	}

	char* buffer;
	int length;
private:
	int allocated;
	static const int bufferinc = 1024;
	void grow()
	{
		allocated += bufferinc;
		buffer = (char*)realloc(buffer, allocated);
		assert(buffer);
	}
};

// Convenient storage for the internal tree
typedef struct {
	std::wstring name;
	std::wstring value;
} XMLAttribute;

typedef struct XMLElement {
	std::wstring name;
	std::wstring text;
	std::vector<XMLElement*> childs;
	std::vector<XMLAttribute*> attrs;
} XMLElement;

class XeroHandler : public DefaultHandler
{
public:
	// SAX2 event handlers:
	virtual void startDocument();
	virtual void endDocument();
	virtual void startElement(const XMLCh* const uri, const XMLCh* const localname, const XMLCh* const qname, const Attributes& attrs);
	virtual void endElement(const XMLCh* const uri, const XMLCh* const localname, const XMLCh* const qname);
	virtual void characters(const XMLCh* const chars, const unsigned int length);

	// Non-SAX2 stuff, used for storing the
	// parsed data and constructing the XMB:
	
	void CreateXMB(unsigned long crc);
	membuffer buffer;
private:
	std::set<std::wstring> ElementNames;
	std::set<std::wstring> AttributeNames;
	XMLElement* Root;
	XMLElement* CurrentElement;
	std::stack<XMLElement*> ElementStack;

	std::map<std::wstring, int> ElementID;
	std::map<std::wstring, int> AttributeID;

	void OutputElement(XMLElement* el);
};



CXeromyces::CXeromyces()
	: XMBFileHandle(0), XMBBuffer(NULL)
{
}

CXeromyces::~CXeromyces() {

	if (XMBFileHandle)
	{
		// If it was read from a file, close it
		vfs_unmap(XMBFileHandle);
		vfs_close(XMBFileHandle);
	}
	else
	{
		// If it was converted from a XML directly into memory,
		// free that memory buffer
		free(XMBBuffer);
	}
}

void CXeromyces::Terminate()
{
	if (XercesLoaded)
	{
		XMLPlatformUtils::Terminate();
		XercesLoaded = 0;
	}
}



void CXeromyces::Load(const char* filename)
{
	// HACK: This is only done so early because CVFSInputSource
	// requires XMLTranscode. It would preferably not be done until
	// we actually need Xerces.
	if (! XercesLoaded)
	{
		XMLPlatformUtils::Initialize();
		XercesLoaded = 1;
	}


	CVFSInputSource source;
	if (source.OpenFile(filename))
	{
		LOG(ERROR, "CXeromyces: Failed to load XML file '%s'", filename);
		throw "Failed to load XML file";
	}
	unsigned long XMLChecksum = source.CRC32();

	// Check whether the XMB file needs to be regenerated:

	// Generate the XMB's filename
	CStr filenameXMB = filename;
	filenameXMB[(int)filenameXMB.Length()-1] = 'b';

	// HACK: Check whether the XMB exists (in a rather unpleasant way)
	char path[VFS_MAX_PATH];
	vfs_realpath(filename, path); // can't get the XMB's VFS path because it doesn't exist
	path[strlen(path)-1] = 'b';
	bool fileExists = false;
	{
		FILE* f = fopen(path, "r");
		if (f) 
		{
			fileExists = true;
			fclose(f);
		}
	}

	// Load the entire file, with the assumption that usually it's
	// going to be valid and will then be passed to XMBFile().
	if (fileExists && ReadXMBFile(filenameXMB.c_str(), true, XMLChecksum))
		return;

	
	// XMB isn't up to date with the XML, so rebuild it:


	SAX2XMLReader* Parser = XMLReaderFactory::createXMLReader();

	// Enable validation
	Parser->setFeature(L"http://xml.org/sax/features/validation", true);
	Parser->setFeature(L"http://apache.org/xml/features/validation/dynamic", true);

	XeroHandler handler;
	Parser->setContentHandler(&handler);

	CXercesErrorHandler errorHandler;
	Parser->setErrorHandler(&errorHandler);

	CVFSEntityResolver entityResolver(filename);
	Parser->setEntityResolver(&entityResolver);

	// Build a tree inside handler
	Parser->parse(source);

	// (It's horribly inefficient doing SAX2->tree then tree->XMB,
	// but the XML->XMB conversion should be done very rarely
	// anyway. If it's ever needed, the XMB writing can be done
	// directly from inside the SAX2 event handlers, although that's
	// a little more complex)

	delete Parser;

	// Convert the data structures into the XMB format
	handler.CreateXMB(XMLChecksum);

	// Save the file to disk, so it can be loaded quickly next time
	vfs_store(filenameXMB, handler.buffer.buffer, handler.buffer.length, FILE_NO_AIO);

	XMBBuffer = handler.buffer.steal_buffer();

	Initialise(XMBBuffer);
}

bool CXeromyces::ReadXMBFile(const char* filename, bool CheckCRC, unsigned long CRC)
{
	Handle file = vfs_open(filename);
	if (file <= 0)
	{
		LOG(ERROR, "CXeromyces: file '%s' couldn't be opened (vfs_open: %lld)\n", filename, file);
		return false;
	}

	void* buffer;
	size_t bufferSize;
	int err;
	if ( (err=vfs_map(file, 0, buffer, bufferSize)) )
	{
		LOG(ERROR, "CXeromyces: file '%s' couldn't be read (vfs_map: %d)\n", filename, err);
		vfs_close(file);
		return false;
	}

	assert(bufferSize >= 42 && "Invalid XMB file"); // 42 bytes is the smallest possible XMB.   (Well, okay, 50 bytes is the smallest, but it was 42 the first time I counted, and 42 is a much nicer number.)
	assert(*(int*)buffer == HeaderMagic && "Invalid XMB file header");

	if (CheckCRC)
	{
		unsigned long fileCRC = *((unsigned long*)buffer + 1); // read the second four-byte number
		if (CRC != fileCRC)
		{
			// Checksums don't match; have to regenerate from the XML
			vfs_unmap(file);
			vfs_close(file);
			return false;
		}
	}

	// Store the Handle so it can be closed later
	XMBFileHandle = file;

	// Set up the XMBFile
	Initialise((char*)buffer);

	return true;
}



void XeroHandler::startDocument()
{
	Root = new XMLElement;
	ElementStack.push(Root);
}

void XeroHandler::endDocument()
{
}

std::wstring lowercase(std::wstring a)
{
	std::wstring b;
	b.resize(a.length());
	for (size_t i = 0; i < a.length(); ++i)
		b[i] = towlower(a[i]);
	return b;
}

void XeroHandler::startElement(const XMLCh* const uri, const XMLCh* const localname, const XMLCh* const qname, const Attributes& attrs)
{
	std::wstring elementName = lowercase(localname);
	ElementNames.insert(elementName);

	// Create a new element
	XMLElement* e = new XMLElement;
	e->name = elementName;

	// Store all the attributes in the new element
	for (unsigned int i = 0; i < attrs.getLength(); ++i)
	{
		std::wstring attrName = lowercase(attrs.getLocalName(i));
		AttributeNames.insert(attrName);
		XMLAttribute* a = new XMLAttribute;
		a->name = attrName;
		a->value = attrs.getValue(i);
		e->attrs.push_back(a);
	}

	// Add the element to its parent
	ElementStack.top()->childs.push_back(e);

	// Set as parent of following elements
	ElementStack.push(e);
}

void XeroHandler::endElement(const XMLCh* const uri, const XMLCh* const localname, const XMLCh* const qname)
{
	ElementStack.pop();
}

void XeroHandler::characters(const XMLCh* const chars, const unsigned int length)
{
	ElementStack.top()->text += chars;
}


void XeroHandler::CreateXMB(unsigned long crc)
{
	// Header
	buffer.write((void*)HeaderMagicStr, 4);

	// Checksum
	buffer.write(&crc, 4);

	std::set<std::wstring>::iterator it;
	int i;

	// Element names
	i = 0;
	int ElementCount = (int)ElementNames.size();
	buffer.write(&ElementCount, 4);
	for (it = ElementNames.begin(); it != ElementNames.end(); ++it)
	{
		int TextLen = 2*((int)it->length()+1);
		buffer.write(&TextLen, 4);
		buffer.write((void*)it->c_str(), TextLen);
		ElementID[*it] = i++;
	}

	// Attribute names
	i = 0;
	int AttributeCount = (int)AttributeNames.size();
	buffer.write(&AttributeCount, 4);
	for (it = AttributeNames.begin(); it != AttributeNames.end(); ++it)
	{
		int TextLen = 2*((int)it->length()+1);
		buffer.write(&TextLen, 4);
		buffer.write((void*)it->c_str(), TextLen);
		AttributeID[*it] = i++;
	}

	// All the XML contents must be surrounded by a single element
	assert(Root->childs.size() == 1);

	OutputElement(Root->childs[0]);
	delete Root;
}

// Writes a whole element (recursively if it has children) into the buffer,
// and also frees all the memory that has been allocated for that element.
void XeroHandler::OutputElement(XMLElement* el)
{
	// Filled in later with the length of the element
	int Pos_Length = buffer.tell();
	buffer.write("????", 4);

	int NameID = ElementID[el->name];
	buffer.write(&NameID, 4);

	int AttrCount = (int)el->attrs.size();
	buffer.write(&AttrCount, 4);

	int ChildCount = (int)el->childs.size();
	buffer.write(&ChildCount, 4);

	// Filled in later with the offset to the list of child elements
	int Pos_ChildrenOffset = buffer.tell();
	buffer.write("????", 4);

	// Trim excess whitespace
	std::wstring whitespace = L" \t\r\n";
	size_t first = el->text.find_first_not_of(whitespace);
	if (first == -1) // entirely whitespace
		el->text = L"";
	else
	{
		size_t last = el->text.find_last_not_of(whitespace);
		el->text = el->text.substr(first, 1+last-first);
	}
	// Output text, prefixed by length in bytes
	int TextLen = 2*((int)el->text.length()+1);
	buffer.write(&TextLen, 4);
	buffer.write((void*)el->text.c_str(), TextLen);

	for (int i = 0; i < AttrCount; ++i)
	{
		int AttrName = AttributeID[el->attrs[i]->name];
		buffer.write(&AttrName, 4);

		int AttrLen = 2*((int)el->attrs[i]->value.length()+1);
		buffer.write(&AttrLen, 4);
		buffer.write((void*)el->attrs[i]->value.c_str(), AttrLen);

		// Free each attribute as soon as it's been dealt with
		delete el->attrs[i];
	}

	// Go back and fill in the child-element offset
	int ChildrenOffset = buffer.tell() - (Pos_ChildrenOffset+4);
	buffer.write(&ChildrenOffset, 4, Pos_ChildrenOffset);

	for (int i = 0; i < ChildCount; ++i)
		OutputElement(el->childs[i]);

	// Go back and fill in the length
	int Length = buffer.tell() - Pos_Length;
	buffer.write(&Length, 4, Pos_Length);

	// Tidy up the parser's mess
	delete el;
}