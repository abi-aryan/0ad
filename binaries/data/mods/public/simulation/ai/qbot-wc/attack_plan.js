// basically an attack plan. The name is an artifact.
function CityAttack(gameState, militaryManager, uniqueID, targetEnemy, type , targetFinder) {
	
	//This is the list of IDs of the units in the plan
	this.idList=[];
	
	this.state = "unexecuted";
	this.targetPlayer = targetEnemy;
	if (this.targetPlayer === -1 || this.targetPlayer === undefined) {
		// let's find our prefered target, basically counting our enemies units.
		var enemyCount = {};
		for (var i = 1; i <=8; i++)
			enemyCount[i] = 0;
		gameState.getEntities().forEach(function(ent) { if (gameState.isEntityEnemy(ent) && ent.owner() !== 0) { enemyCount[ent.owner()]++; } });
		var max = 0;
		for (i in enemyCount)
			if (enemyCount[i] > max && +i !== PlayerID)
			{
				this.targetPlayer = +i;
				max = enemyCount[i];
			}
	}
	if (this.targetPlayer === undefined || this.targetPlayer === -1)
		return false;
	debug ("Target = " +this.targetPlayer);
	this.targetFinder = targetFinder || this.defaultTargetFinder;
	this.type = type || "normal";
	this.name = uniqueID;
	this.healthRecord = [];
		
	this.timeOfPlanStart = gameState.getTimeElapsed();	// we get the time at which we decided to start the attack
	this.maxPreparationTime = 300*1000;
	
	this.pausingStart = 0;
	this.totalPausingTime = 0;
	this.paused = false;
	
	this.onArrivalReaction = "proceedOnTargets";

	// priority is relative. If all are 0, the only relevant criteria is "currentsize/targetsize".
	// if not, this is a "bonus". The higher the priority, the more this unit will get built.
	// Should really be clamped to [0.1-1.5] (assuming 1 is default/the norm)
	// Eg: if all are priority 1, and the siege is 0.5, the siege units will get built
	// only once every other category is at least 50% of its target size.
	this.unitStat = {};
	this.unitStat["RangedInfantry"] = { "priority" : 1, "minSize" : 4, "targetSize" : 10, "batchSize" : 5, "classes" : ["Infantry","Ranged"],
		"interests" : [ ["strength",2], ["cost",1] ], "templates" : [] };
	this.unitStat["MeleeInfantry"] = { "priority" : 1, "minSize" : 4, "targetSize" : 10, "batchSize" : 5, "classes" : ["Infantry","Melee"],
		"interests" : [ ["strength",2], ["cost",1] ], "templates" : [] };
	this.unitStat["MeleeCavalry"] = { "priority" : 1, "minSize" : 3, "targetSize" : 8 , "batchSize" : 3, "classes" : ["Cavalry","Melee"],
		"interests" : [ ["strength",2], ["cost",1] ], "templates" : [] };
	this.unitStat["RangedCavalry"] = { "priority" : 1, "minSize" : 3, "targetSize" : 8 , "batchSize" : 3, "classes" : ["Cavalry","Ranged"],
		"interests" : [ ["strength",2], ["cost",1] ], "templates" : [] };
	this.unitStat["Siege"] = { "priority" : 0.5, "minSize" : 0, "targetSize" : 3 , "batchSize" : 1, "classes" : ["Siege"], "interests" : [ ["siegeStrength", 3], ["cost",1] ], "templates" : [] };
	var priority = 60;

	if (type === "rush") {
		// we have 3 minutes to train infantry.
		delete this.unitStat["RangedInfantry"];
		delete this.unitStat["MeleeInfantry"];
		delete this.unitStat["MeleeCavalry"];
		delete this.unitStat["RangedCavalry"];
		delete this.unitStat["Siege"];
		this.unitStat["Infantry"] = { "priority" : 1, "minSize" : 10, "targetSize" : 30, "batchSize" : 1, "classes" : ["Infantry"], "interests" : [ ["strength",1], ["cost",1] ], "templates" : [] };
		this.maxPreparationTime = 150*1000;
		priority = 150;
	} else if (type === "superSized") {
		this.unitStat["RangedInfantry"] = { "priority" : 1, "minSize" : 5, "targetSize" : 18, "batchSize" : 5, "classes" : ["Infantry","Ranged"],
			"interests" : [ ["strength",2], ["cost",1] ], "templates" : [] };
		this.unitStat["MeleeInfantry"] = { "priority" : 1, "minSize" : 6, "targetSize" : 24, "batchSize" : 5, "classes" : ["Infantry","Melee"],
			"interests" : [ ["strength",2], ["cost",1] ], "templates" : [] };
		this.unitStat["MeleeCavalry"] = { "priority" : 1, "minSize" : 4, "targetSize" : 12 , "batchSize" : 5, "classes" : ["Cavalry","Melee"],
			"interests" : [ ["strength",2], ["cost",1] ], "templates" : [] };
		this.unitStat["RangedCavalry"] = { "priority" : 1, "minSize" : 4, "targetSize" : 12 , "batchSize" : 5, "classes" : ["Cavalry","Ranged"],
			"interests" : [ ["strength",2], ["cost",1] ], "templates" : [] };
		this.unitStat["Siege"] = { "priority" : 0.5, "minSize" : 3, "targetSize" : 6 , "batchSize" : 3, "classes" : ["Siege"],"interests" : [ ["siegeStrength",3], ["cost",1] ], "templates" : [] };
		this.maxPreparationTime = 450*1000;
		priority = 70;
	} else if (gameState.getTimeElapsed() > 15*60*1000)
		this.unitStat["Siege"]["minSize"] = 2;

	gameState.ai.queueManager.addQueue("plan_" + this.name, priority);
	this.queue = gameState.ai.queues["plan_" + this.name];

	/*
	this.unitStat["Siege"]["filter"] = function (ent) {
		var strength = [ent.attackStrengths("Melee")["crush"],ent.attackStrengths("Ranged")["crush"]];
		return (strength[0] > 15 || strength[1] > 15);
	};*/

	var filter = Filters.and(Filters.byMetadata(PlayerID, "plan",this.name),Filters.byOwner(PlayerID));
	this.unitCollection = gameState.getOwnEntities().filter(filter);
	this.unitCollection.registerUpdates();
	this.unitCollection.length;
	
	this.unit = {};
	
	// each array is [ratio, [associated classes], associated EntityColl, associated unitStat, name ]
	this.buildOrder = [];
	
	// defining the entity collections. Will look for units I own, that are part of this plan.
	// Also defining the buildOrders.
	for (unitCat in this.unitStat) {
		var cat = unitCat;
		var Unit = this.unitStat[cat];

		filter = Filters.and(Filters.byClassesAnd(Unit["classes"]),Filters.and(Filters.byMetadata(PlayerID, "plan",this.name),Filters.byOwner(PlayerID)));
		this.unit[cat] = gameState.getOwnEntities().filter(filter);
		this.unit[cat].registerUpdates();
		this.unit[cat].length;
		this.buildOrder.push([0, Unit["classes"], this.unit[cat], Unit, cat]);
	}
	/*if (gameState.getTimeElapsed() > 900000)	// 15 minutes
	{
		
		this.unitStat.Cavalry.Ranged["minSize"] = 5;
		this.unitStat.Cavalry.Melee["minSize"] = 5;
		this.unitStat.Infantry.Ranged["minSize"] = 10;
		this.unitStat.Infantry.Melee["minSize"] = 10;
		this.unitStat.Cavalry.Ranged["targetSize"] = 10;
		this.unitStat.Cavalry.Melee["targetSize"] = 10;
		this.unitStat.Infantry.Ranged["targetSize"] = 20;
		this.unitStat.Infantry.Melee["targetSize"] = 20;
		this.unitStat.Siege["targetSize"] = 5;
		this.unitStat.Siege["minSize"] = 2;
		 
	} else {
		this.maxPreparationTime = 180000;
	}*/
	// todo: REACTIVATE (in all caps)
	if (type === "harass_raid" && 0 == 1)
	{
		this.targetFinder = this.raidingTargetFinder;
		this.onArrivalReaction = "huntVillagers";
		
		this.type = "harass_raid";
		// This is a Cavalry raid against villagers. A Cavalry Swordsman has a bonus against these. Only build these
		this.maxPreparationTime = 180000;	// 3 minutes.
		if (gameState.playerData.civ === "hele")	// hellenes have an ealry Cavalry Swordsman
		{
			this.unitCount.Cavalry.Melee = { "subCat" : ["Swordsman"] , "usesSubcategories" : true, "Swordsman" : undefined, "priority" : 1, "currentAmount" : 0, "minimalAmount" : 0, "preferedAmount" : 0 };
			this.unitCount.Cavalry.Melee.Swordsman = { "priority" : 1, "currentAmount" : 0, "minimalAmount" : 4, "preferedAmount" : 7, "fallback" : "abort" };
		} else {
			this.unitCount.Cavalry.Melee = { "subCat" : undefined , "usesSubcategories" : false, "priority" : 1, "currentAmount" : 0, "minimalAmount" : 4, "preferedAmount" : 7 };
		}
		this.unitCount.Cavalry.Ranged["minimalAmount"] = 0;
		this.unitCount.Cavalry.Ranged["preferedAmount"] = 0;
		this.unitCount.Infantry.Ranged["minimalAmount"] = 0;
		this.unitCount.Infantry.Ranged["preferedAmount"] = 0;
		this.unitCount.Infantry.Melee["minimalAmount"] = 0;	
		this.unitCount.Infantry.Melee["preferedAmount"] = 0;
		this.unitCount.Siege["preferedAmount"] = 0;
	}
	this.anyNotMinimal = true;	// used for support plans

	// taking this so that fortresses won't crash it for now. TODO: change the rally point if it becomes invalid
	if(gameState.ai.pathsToMe.length > 1)
		var position = [(gameState.ai.pathsToMe[0][0]+gameState.ai.pathsToMe[1][0])/2.0,(gameState.ai.pathsToMe[0][1]+gameState.ai.pathsToMe[1][1])/2.0];
	else if (gameState.ai.pathsToMe.length !== 0)
		var position = [gameState.ai.pathsToMe[0][0],gameState.ai.pathsToMe[0][1]];
	else
		var position = [-1,-1];
	
	var CCs = gameState.getOwnEntities().filter(Filters.byClass("CivCentre"));
	var nearestCCArray = CCs.filterNearest(position, 1).toEntityArray();
	var CCpos = nearestCCArray[0].position();
	this.rallyPoint = [0,0];
	if (position[0] !== -1) {
		this.rallyPoint[0] = (position[0]*3 + CCpos[0]) / 4.0;
		this.rallyPoint[1] = (position[1]*3 + CCpos[1]) / 4.0;
	} else {
		this.rallyPoint[0] = CCpos[0];
		this.rallyPoint[1] = CCpos[1];
	}
	if (type == 'harass_raid')
	{
		this.rallyPoint[0] = (position[0]*3.9 + 0.1 * CCpos[0]) / 4.0;
		this.rallyPoint[1] = (position[1]*3.9 + 0.1 * CCpos[1]) / 4.0;
	}
	
	// some variables for during the attack
	this.lastPosition = [0,0];
	this.position = [0,0];

	this.threatList = [];	// sounds so FBI
	this.tactics = undefined;
	
	this.assignUnits(gameState);
	
	//debug ("Before");
	//Engine.DumpHeap();
	
	// get a good path to an estimated target.
	this.pathFinder = new aStarPath(gameState,false);
	this.onBoat = false;	// tells us if our units are loaded on boats.
	this.needsShip = false;
	
	//debug ("after");
	//Engine.DumpHeap();
	return true;
};

CityAttack.prototype.getName = function(){
	return this.name;
};
CityAttack.prototype.getType = function(){
	return this.type;
};
// Returns true if the attack can be executed at the current time
// Basically his checks we have enough units.
// We run a count of our units.
CityAttack.prototype.canStart = function(gameState){	
	for (unitCat in this.unitStat) {
		var Unit = this.unitStat[unitCat];
		if (this.unit[unitCat].length < Unit["minSize"])
			return false;
	}
	return true;

	// TODO: check if our target is valid and a few other stuffs (good moment to attack?)
};
CityAttack.prototype.isStarted = function(){
	if ((this.state !== "unexecuted"))
		debug ("Attack plan already started");
	return !(this.state == "unexecuted");
};

CityAttack.prototype.isPaused = function(){
	return this.paused;
};
CityAttack.prototype.setPaused = function(gameState, boolValue){
	if (!this.paused && boolValue === true) {
		this.pausingStart = gameState.getTimeElapsed();
		this.paused = true;
		debug ("Pausing attack plan " +this.name);
	} else if (this.paused && boolValue === false) {
		this.totalPausingTime += gameState.getTimeElapsed() - this.pausingStart;
		this.paused = false;
		debug ("Unpausing attack plan " +this.name);
	}
};
CityAttack.prototype.mustStart = function(gameState){
	if (this.isPaused())
		return false;
	var MaxReachedEverywhere = true;
	for (unitCat in this.unitStat) {
		var Unit = this.unitStat[unitCat];
		if (this.unit[unitCat].length < Unit["targetSize"]) {
			MaxReachedEverywhere = false;
		}
	}
	if (MaxReachedEverywhere)
		return true;
	return (this.maxPreparationTime + this.timeOfPlanStart + this.totalPausingTime < gameState.getTimeElapsed());
};

// Three returns possible: 1 is "keep going", 0 is "failed plan", 2 is "start"
// 3 is a special case: no valid path returned. Right now I stop attacking alltogether.
CityAttack.prototype.updatePreparation = function(gameState, militaryManager,events) {
	var self = this;
	
	if (this.path == undefined || this.target == undefined) {
		// find our target
		var targets = this.targetFinder(gameState, militaryManager);
		if (targets.length === 0){
			targets = this.defaultTargetFinder(gameState, militaryManager);
		}
		if (targets.length) {
			// picking a target
			var rand = Math.floor((Math.random()*targets.length));
			this.targetPos = undefined;
			var count = 0;
			while (!this.targetPos){
				this.target = targets.toEntityArray()[rand];
				this.targetPos = this.target.position();
				count++;
				if (count > 1000){
					debug("No target with a valid position found");
					return false;
				}
			}
			// when we have a target, we path to it.
			this.path = this.pathFinder.getPath(this.rallyPoint,this.targetPos, 3, 3);//,300000,gameState);
			
			if (this.path === undefined) {
				delete this.pathFinder;
				return 3;	// no path.
			} else if (this.path[1] === true) {
				// okay so we need a ship.
				// Basically we'll add it as a new class to train compulsorily, and we'll recompute our path.
				debug ("We need a ship.");
				if (!gameState.ai.waterMap)
				{
					debug ("This is actually a water map.");
					gameState.ai.waterMap = true;
				}
				this.unitStat["TransportShip"] = { "priority" : 1.1, "minSize" : 2, "targetSize" : 2, "batchSize" : 1, "classes" : ["Warship"], "templates" : [] };
				if (type === "superSized") {
					this.unitStat["TransportShip"]["minSize"] = 4;
					this.unitStat["TransportShip"]["targetSize"] = 4;
				}
				var Unit = this.unitStat["TransportShip"];
				var filter = Filters.and(Filters.byClassesAnd(Unit["classes"]),Filters.and(Filters.byMetadata(PlayerID, "plan",this.name),Filters.byOwner(PlayerID)));
				this.unit["TransportShip"] = gameState.getOwnEntities().filter(filter);
				this.unit["TransportShip"].registerUpdates();
				this.unit["TransportShip"].length;
				this.buildOrder.push([0, Unit["classes"], this.unit["TransportShip"], Unit, "TransportShip"]);
				this.needsShip = true;
			}
			this.path = this.path[0].reverse();
			delete this.pathFinder;
		}  else if (targets.length == 0 ) {
			gameState.ai.gameFinished = true;
			debug ("I do not have any target. So I'll just assume I won the game.");
			return 0;
		}
	}
	
	Engine.ProfileStart("Update Preparation");
	
	// keep on while the units finish being trained.
	if (this.mustStart(gameState) && (gameState.countOwnQueuedEntitiesWithMetadata("plan", +this.name) + this.queue.countTotalQueuedUnits()) > 0 ) {
		this.assignUnits(gameState);
		if ( (gameState.ai.turn + gameState.ai.player) % 40 == 0) {
			this.AllToRallyPoint(gameState, true);	// gain some time, start regrouping
		}
		Engine.ProfileStop();
		return 1;
	} else if (!this.mustStart(gameState)) {
		// We still have time left to recruit units and do stuffs.
		
		// let's sort by training advancement, ie 'current size / target size'
		// count the number of queued units too.
		// substract priority.
		this.buildOrder.sort(function (a,b) { //}) {
							 
			var aQueued = gameState.countOwnQueuedEntitiesWithMetadata("special","Plan_"+self.name+"_"+self.buildOrder[0][4]);
			aQueued += self.queue.countTotalQueuedUnitsWithMetadata("special","Plan_"+self.name+"_"+self.buildOrder[0][4]);
			a[0] = (a[2].length + aQueued)/a[3]["targetSize"];
							 
			var bQueued = gameState.countOwnQueuedEntitiesWithMetadata("special","Plan_"+self.name+"_"+self.buildOrder[0][4]);
			bQueued += self.queue.countTotalQueuedUnitsWithMetadata("special","Plan_"+self.name+"_"+self.buildOrder[0][4]);
			b[0] = (b[2].length + bQueued)/b[3]["targetSize"];
							 
			a[0] -= a[3]["priority"];
			b[0] -= b[3]["priority"];
			return (a[0]) - (b[0]);
		});
		
		if (!this.isPaused()) {
			this.assignUnits(gameState);
		
			if ( (gameState.ai.turn + gameState.ai.player) % 40 == 0) {
				this.AllToRallyPoint(gameState, false);
				this.unitCollection.setStance("defensive");	// make sure units won't disperse out of control
			}
		}
		
		Engine.ProfileStart("Creating units.");
		
		// gets the number in training of the same kind as the first one.
		var specialData = "Plan_"+this.name+"_"+this.buildOrder[0][4];
		var inTraining = gameState.countOwnQueuedEntitiesWithMetadata("special",specialData);
		if (this.queue.countTotalQueuedUnits() + inTraining + this.buildOrder[0][2].length < Math.min(15,this.buildOrder[0][3]["targetSize"]) ) {
			if (this.buildOrder[0][0] < 1 && this.queue.length() < 4) {

				var template = militaryManager.findBestTrainableUnit(gameState, this.buildOrder[0][1], this.buildOrder[0][3]["interests"] );
				//debug ("tried " + uneval(this.buildOrder[0][1]) +", and " + template);
				// HACK (TODO replace) : if we have no trainable template... Then we'll simply remove the buildOrder, effectively removing the unit from the plan.
				if (template === undefined) {
					delete this.unitStat[this.buildOrder[0][4]];	// deleting the associated unitstat.
					this.buildOrder.splice(0,1);
				} else {
					var max = this.buildOrder[0][3]["batchSize"];
					if (this.type === "superSized")
						max *= 2;
					if (gameState.getTemplate(template).hasClasses(["CitizenSoldier", "Infantry"]))
						this.queue.addItem( new UnitTrainingPlan(gameState,template, { "role" : "worker", "plan" : this.name, "special" : specialData }, this.buildOrder[0][3]["batchSize"],max ) );
					else
						this.queue.addItem( new UnitTrainingPlan(gameState,template, { "role" : "attack", "plan" : this.name, "special" : specialData }, this.buildOrder[0][3]["batchSize"],max ) );
				}
			}
		}
		/*
		if (!this.startedPathing && this.path === undefined) {
			
			// find our target
			var targets = this.targetFinder(gameState, militaryManager);
			if (targets.length === 0){
				targets = this.defaultTargetFinder(gameState, militaryManager);
			}
			if (targets.length) {
				var rand = Math.floor((Math.random()*targets.length));
				this.targetPos = undefined;
				var count = 0;
				while (!this.targetPos){
					var target = targets.toEntityArray()[rand];
					this.targetPos = target.position();
					count++;
					if (count > 1000){
						debug("No target with a valid position found");
						return false;
					}
				}
				this.startedPathing = true;
				// Start pathfinding using the optimized version, with a minimal sampling of 2
				this.pathFinder.getPath(this.rallyPoint,this.targetPos, false, 2, gameState);
			}
		} else if (this.startedPathing) {
			var path = this.pathFinder.continuePath(gameState);
			if (path !== "toBeContinued") {
				this.startedPathing = false;
				this.path = path;
				debug("Pathing ended");
			}
		}
		*/
		// can happen for now
		if (this.buildOrder.length === 0) {
			debug ("Ending plan: no build orders");
			return 0;	// will abort the plan, should return something else
		}
		Engine.ProfileStop();
		Engine.ProfileStop();
		return 1;
	}
	this.unitCollection.forEach(function (entity) { entity.setMetadata(PlayerID, "role","attack"); });

	Engine.ProfileStop();
	// if we're here, it means we must start (and have no units in training left).
	// if we can, do, else, abort.
	if (this.canStart(gameState))
		return 2;
	else
		return 0;
	return 0;
};
CityAttack.prototype.assignUnits = function(gameState){
	var self = this;

	// TODO: assign myself units that fit only, right now I'm getting anything.
	// Assign all no-roles that fit (after a plan aborts, for example).
	var NoRole = gameState.getOwnEntitiesByRole(undefined);
	if (this.type === "rush")
		NoRole = gameState.getOwnEntitiesByRole("worker");
	NoRole.forEach(function(ent) {
		if (ent.hasClasses(["CitizenSoldier", "Infantry"]))
			ent.setMetadata(PlayerID, "role", "worker");
		else
			ent.setMetadata(PlayerID, "role", "attack");
		ent.setMetadata(PlayerID, "plan", self.name);
	});

};
// this sends a unit by ID back to the "rally point"
CityAttack.prototype.ToRallyPoint = function(gameState,id)
{	
	// Move back to nearest rallypoint
	gameState.getEntityById(id).move(this.rallyPoint[0],this.rallyPoint[1]);
}
// this sends all units back to the "rally point" by entity collections.
// It doesn't disturb ones that could be currently defending, even if the plan is not (yet) paused.
CityAttack.prototype.AllToRallyPoint = function(gameState, evenWorkers) {
	var self = this;
	if (evenWorkers) {
		for (unitCat in this.unit) {
			this.unit[unitCat].forEach(function (ent) {
				if (ent.getMetadata(PlayerID, "role") != "defence" && !ent.hasClass("Warship"))
					ent.move(self.rallyPoint[0],self.rallyPoint[1]);
			});
		}
	} else {
		for (unitCat in this.unit) {
			this.unit[unitCat].forEach(function (ent) {
				if (ent.getMetadata(PlayerID, "role") != "worker" && ent.getMetadata(PlayerID, "role") != "defence"  && !ent.hasClass("Warship"))
					ent.move(self.rallyPoint[0],self.rallyPoint[1]);
			});
		}
	}
}

// Default target finder aims for conquest critical targets
CityAttack.prototype.defaultTargetFinder = function(gameState, militaryManager){
	var targets = undefined;
	
	targets = militaryManager.enemyWatchers[this.targetPlayer].getEnemyBuildings(gameState, "CivCentre",true);
	if (targets.length == 0) {
		targets = militaryManager.enemyWatchers[this.targetPlayer].getEnemyBuildings(gameState, "ConquestCritical");
	}
	// If there's nothing, attack anything else that's less critical
	if (targets.length == 0) {
		targets = militaryManager.enemyWatchers[this.targetPlayer].getEnemyBuildings(gameState, "Town",true);
	}
	if (targets.length == 0) {
		targets = militaryManager.enemyWatchers[this.targetPlayer].getEnemyBuildings(gameState, "Village",true);
	}
	// no buildings, attack anything conquest critical, even units (it's assuming it won't move).
	if (targets.length == 0) {
		targets = gameState.getEnemyEntities().filter(Filters.byClass("ConquestCritical"));
	}
	debug ("target is " + targets);
	return targets;
};

// tupdate
CityAttack.prototype.raidingTargetFinder = function(gameState, militaryManager, Target){
	var targets = undefined;
	if (Target == "villager")
	{
		// let's aim for any resource dropsite. We assume villagers are in the neighborhood (note: the human player could certainly troll us... small (scouting) TODO here.)
		targets = gameState.entities.filter(function(ent) {
				return (ent.hasClass("Structure") && ent.resourceDropsiteTypes() !== undefined && !ent.hasClass("CivCentre") && ent.owner() === this.targetPlayer && ent.position());
		});
		if (targets.length == 0) {
			targets = gameState.entities.filter(function(ent) {
												return (ent.hasClass("CivCentre") && ent.resourceDropsiteTypes() !== undefined && ent.owner() === this.targetPlayer  && ent.position());
												});
		}
		if (targets.length == 0) {
			// if we're here, it means they also don't have no CC... So I'll just take any building at this point.
			targets = gameState.entities.filter(function(ent) {
												return (ent.hasClass("Structure") && ent.owner() === this.targetPlayer  && ent.position());
												});
		}
		return targets;
	} else {
		return this.defaultTargetFinder(gameState, militaryManager);
	}
};

// Executes the attack plan, after this is executed the update function will be run every turn
// If we're here, it's because we have in our IDlist enough units.
// now the IDlist units are treated turn by turn
CityAttack.prototype.StartAttack = function(gameState, militaryManager){
	
	// check we have a target and a path.
	if (this.targetPos && this.path !== undefined) {
		// erase our queue. This will stop any leftover unit from being trained.
		gameState.ai.queueManager.removeQueue("plan_" + this.name);
		
		var curPos = this.unitCollection.getCentrePosition();
		
		this.unitCollection.forEach(function(ent) { ent.setMetadata(PlayerID, "subrole", "attacking"); ent.setMetadata(PlayerID, "role", "attack") ;});
		
		// filtering by those that started to attack only
		var filter = Filters.byMetadata(PlayerID, "subrole","attacking");
		this.unitCollection = this.unitCollection.filter(filter);
		this.unitCollection.registerUpdates();
		//this.unitCollection.length;
		
		for (unitCat in this.unitStat) {
			var cat = unitCat;
			this.unit[cat] = this.unit[cat].filter(filter);
		}
		
		this.unitCollection.move(this.path[0][0][0], this.path[0][0][1]);
		this.unitCollection.setStance("aggressive");	// make sure units won't disperse out of control
		
		debug ("Started to attack with the plan " + this.name);
		this.state = "walking";
	} else {
		gameState.ai.gameFinished = true;
		debug ("I do not have any target. So I'll just assume I won the game.");
		return true;
	}
	return true;
};

// Runs every turn after the attack is executed
CityAttack.prototype.update = function(gameState, militaryManager, events){
	var self = this;
	Engine.ProfileStart("Update Attack");

	// we're marching towards the target
	// Check for attacked units in our band.
	var bool_attacked = false;
	// raids don't care about attacks much
	
	if (this.unitCollection.length === 0)
		return 0;
	
	this.position = this.unitCollection.getCentrePosition();
	
	var IDs = this.unitCollection.toIdArray();
	
	// this actually doesn't do anything right now.
	if (this.state === "walking") {
		
		var toProcess = {};
		var armyToProcess = {};
		// Let's check if any of our unit has been attacked. In case yes, we'll determine if we're simply off against an enemy army, a lone unit/builing
		// or if we reached the enemy base. Different plans may react differently.
		for (var key in events) {
			var e = events[key];
			if (e.type === "Attacked" && e.msg) {
				if (IDs.indexOf(e.msg.target) !== -1) {
					var attacker = gameState.getEntityById(e.msg.attacker);
					var ourUnit = gameState.getEntityById(e.msg.target);

					if (attacker && attacker.position() && attacker.hasClass("Unit") && attacker.owner() != 0 && attacker.owner() != PlayerID) {
						
						var territoryMap = Map.createTerritoryMap(gameState);
						if ( +territoryMap.point(attacker.position()) - 64 === +this.targetPlayer)
						{
							debug ("Attack Plan " +this.type +" " +this.name +" has arrived to destination.");
							// we must assume we've arrived at the end of the trail.
							this.state = "arrived";
						}
						//if (militaryManager.enemyWatchers[attacker.owner()]) {
							//toProcess[attacker.id()] = attacker;
							//var armyID = militaryManager.enemyWatchers[attacker.owner()].getArmyFromMember(attacker.id());
							//armyToProcess[armyID[0]] = armyID[1];
						//}
					}
					// if we're being attacked by a building, flee.
					if (attacker && ourUnit && attacker.hasClass("Structure")) {
						ourUnit.flee(attacker);
					}
				}
			}
		}
		
		// I don't process attacks if I'm in their base because I'll have already gone to "attacking" mode.
		// I'll process by army
		var total = 0;
		for (armyID in armyToProcess) {
			total += armyToProcess[armyID].length;
			// TODO: if it's a big army, we may want to refer the scouting/defense manager
		}
		

		/*
		 
	}&& this.type !== "harass_raid"){	// walking toward the target
		var sumAttackerPos = [0,0];
		var numAttackers = 0;
		// let's check if one of our unit is not under attack, by any chance.
		for (var key in events){
			var e = events[key];
			if (e.type === "Attacked" && e.msg){
				if (this.unitCollection.toIdArray().indexOf(e.msg.target) !== -1){
					var attacker = HeadQuarters.entity(e.msg.attacker);
					if (attacker && attacker.position()){
						sumAttackerPos[0] += attacker.position()[0];
						sumAttackerPos[1] += attacker.position()[1];
						numAttackers += 1;
						bool_attacked = true;
						// todo: differentiate depending on attacker type... If it's a ship, let's not do anythin, a building, depends on the attack type/
						if (this.threatList.indexOf(e.msg.attacker) === -1)
						{
							var enemySoldiers = HeadQuarters.getEnemySoldiers().toEntityArray();
							for (j in enemySoldiers)
							{
								var enemy = enemySoldiers[j];
								if (enemy.position() === undefined)	// likely garrisoned
									continue;
								if (inRange(enemy.position(), attacker.position(), 1000) && this.threatList.indexOf(enemy.id()) === -1)
									this.threatList.push(enemy.id());
							}
							this.threatList.push(e.msg.attacker);
						}
					}
				}
			}
		}
		if (bool_attacked > 0){
			var avgAttackerPos = [sumAttackerPos[0]/numAttackers, sumAttackerPos[1]/numAttackers];
			units.move(avgAttackerPos[0], avgAttackerPos[1]);	// let's run towards it.
			this.tactics = new Tactics(gameState,HeadQuarters, this.idList,this.threatList,true);
			this.state = "attacking_threat";
		}
	}else if (this.state === "attacking_threat"){
		this.tactics.eventMetadataCleanup(events,HeadQuarters);
		var removeList = this.tactics.removeTheirDeads(HeadQuarters);
		this.tactics.removeMyDeads(HeadQuarters);
		for (var i in removeList){
			this.threatList.splice(this.threatList.indexOf(removeList[i]),1);
		}
		if (this.threatList.length <= 0)
		{
			this.tactics.disband(HeadQuarters,events);
			this.tactics = undefined;
			this.state = "walking";
			units.move(this.path[0][0], this.path[0][1]);
		}else
		{
			this.tactics.reassignAttacks(HeadQuarters);
		}
	}*/
	}
	if (this.state === "walking"){
		
		this.position = this.unitCollection.filter(Filters.not(Filters.byClass("Warship"))).getCentrePosition();
		
		// probably not too good.
		if (!this.position)
			return undefined;	// should spawn an error.
		
		// basically haven't moved an inch: very likely stuck)
		if (this.position[0] == this.lastPosition[0] && this.position[1] == this.lastPosition[1] && this.path.length > 0) {
			// check for stuck siege units
			var sieges = this.unitCollection.filter(Filters.byClass("Siege"));
			var farthest = 0;
			var farthestEnt = -1;
			sieges.forEach (function (ent) {
				if (SquareVectorDistance(ent.position(),self.position) > farthest)
				{
					farthest = SquareVectorDistance(ent.position(),self.position);
					farthestEnt = ent;
				}
			});
			if (farthestEnt !== -1)
				farthestEnt.destroy();
		}
		
		if (SquareVectorDistance(this.position, this.lastPosition) < 20 && this.path.length > 0) {
			this.unitCollection.filter(Filters.not(Filters.byClass("Warship"))).moveIndiv(this.path[0][0][0], this.path[0][0][1]);
			// We're stuck, presumably. Check if there are no walls just close to us. If so, we're arrived, and we're gonna tear down some serious stone.
			var walls = gameState.getEnemyEntities().filter(Filters.and(Filters.byOwner(this.targetPlayer), Filters.byClass("StoneWall")));
			var nexttoWalls = false;
			walls.forEach( function (ent) {
				if (!nexttoWalls && SquareVectorDistance(self.position, ent.position()) < 800)
					nexttoWalls = true;
			});
			// there are walls but we can attack
			if (nexttoWalls && this.unitCollection.filter(Filters.byCanAttack("StoneWall")).length !== 0)
			{
				debug ("Attack Plan " +this.type +" " +this.name +" has met walls and is not happy.");
				this.state = "arrived";
			} else if (nexttoWalls) {
				// abort plan.
				debug ("Attack Plan " +this.type +" " +this.name +" has met walls and gives up.");
				return 0;
			}
		}
		
		// check if our land units are close enough from the next waypoint.
		if (SquareVectorDistance(this.unitCollection.filter(Filters.not(Filters.byClass("Warship"))).getCentrePosition(), this.path[0][0]) < 600) {
			if (this.unitCollection.filter(Filters.byClass("Siege")).length !== 0
				&& SquareVectorDistance(this.unitCollection.filter(Filters.byClass("Siege")).getCentrePosition(), this.path[0][0]) > 600)
			{
			} else {
				// okay so here basically two cases. The first one is "we need a boat at this point".
				// the second one is "we need to unload at this point". The third is "normal".
				if (this.path[0][1] !== true)
				{
					this.path.shift();
					if (this.path.length > 0){
						this.unitCollection.filter(Filters.not(Filters.byClass("Warship"))).moveIndiv(this.path[0][0][0], this.path[0][0][1]);
					} else {
						debug ("Attack Plan " +this.type +" " +this.name +" has arrived to destination.");
						// we must assume we've arrived at the end of the trail.
						this.state = "arrived";
					}
				} else if (this.path[0][1] === true)
				{
					// okay we must load our units.
					// check if we have some kind of ships.
					var ships = this.unitCollection.filter(Filters.byClass("Warship"));
					if (ships.length === 0)
						return 0; // abort
				
					debug ("switch to boarding");
					this.state = "boarding";
				}
			}
		}
	} else if (this.state === "shipping") {
		this.position = this.unitCollection.filter(Filters.byClass("Warship")).getCentrePosition();

		if (SquareVectorDistance(this.position, this.lastPosition) < 20 && this.path.length > 0) {
			this.unitCollection.filter(Filters.byClass("Warship")).moveIndiv(this.path[0][0][0], this.path[0][0][1]);
		}
		if (SquareVectorDistance(this.position, this.path[0][0]) < 1600) {
			if (this.path[0][1] !== true)
			{
				this.path.shift();
				if (this.path.length > 0){
					this.unitCollection.filter(Filters.byClass("Warship")).moveIndiv(this.path[0][0][0], this.path[0][0][1]);
				} else {
					debug ("Attack Plan " +this.type +" " +this.name +" has arrived to destination, but it's still on the ship…");
					return 0; // abort
				}
			} else if (this.path[0][1] === true)
			{
				debug ("switch to unboarding");
				// we unload
				this.state = "unboarding";
			}
		}
	} else if (this.state === "boarding") {
		this.position = this.unitCollection.filter(Filters.not(Filters.byClass("Warship"))).getCentrePosition();

		var ships = this.unitCollection.filter(Filters.byClass("Warship"));
		if (ships.length === 0)
			return 0; // abort
		
		var globalPos = this.unitCollection.filter(Filters.not(Filters.byClass("Warship"))).getCentrePosition();
		var shipPos = ships.getCentrePosition();

		if (globalPos !== undefined && SquareVectorDistance(globalPos,shipPos) > 800)
		{	// get them closer
			ships.moveIndiv(globalPos[0],globalPos[1]);
			this.unitCollection.filter(Filters.not(Filters.byClass("Warship"))).moveIndiv(shipPos[0],shipPos[1]);
		} else {
			// okay try to garrison.
			var shipsArray = ships.toEntityArray();
			this.unitCollection.filter(Filters.not(Filters.byClass("Warship"))).forEach(function (ent) { //}){
				if (ent.position())	// if we're not garrisoned
					for (var shipId = 0; shipId < shipsArray.length; shipId++) {
						if (shipsArray[shipId].garrisoned().length < shipsArray[shipId].garrisonMax())
						{
							ent.garrison(shipsArray[shipId]);
							break;
						}
					}
			});
			var garrLength = 0;
			for (var shipId = 0; shipId < shipsArray.length; shipId++)
				garrLength += shipsArray[shipId].garrisoned().length;
			
			if (garrLength == this.unitCollection.filter(Filters.not(Filters.byClass("Warship"))).length) {
				// okay.
				this.path.shift();
				if (this.path.length > 0){
					ships.moveIndiv(this.path[0][0][0], this.path[0][0][1]);
					debug ("switch to shipping");
					this.state = "shipping";
				} else {
					debug ("Attack Plan " +this.type +" " +this.name +" has arrived to destination.");
					// we must assume we've arrived at the end of the trail.
					this.state = "arrived";
				}
			}
		}
	} else if (this.state === "unboarding") {
		
		var ships = this.unitCollection.filter(Filters.byClass("Warship"));
		if (ships.length === 0)
			return 0; // abort
		
		this.position = ships.getCentrePosition();
		
		// the procedure is pretty simple: we move the ships to the next point and try to unload until all units are over.
		// TODO: make it better, like avoiding collisions, and so on.

		if (this.path.length > 1)
			ships.moveIndiv(this.path[1][0][0], this.path[1][0][1]);

		ships.forEach(function (ship) {
			ship.unloadAll();
		});
		
		var shipsArray = ships.toEntityArray();
		var garrLength = 0;
		for (var shipId = 0; shipId < shipsArray.length; shipId++)
			garrLength += shipsArray[shipId].garrisoned().length;
			
		if (garrLength == 0) {
			// release the ships
			
			ships.forEach(function (ent) {
				ent.setMetadata(PlayerID, "role",undefined);
				ent.setMetadata(PlayerID, "subrole",undefined);
				ent.setMetadata(PlayerID, "plan",undefined);
			});
			for (var shipId = 0; shipId < shipsArray.length; shipId++)
				this.unitCollection.removeEnt(shipsArray[shipId]);
			
			this.path.shift();
			if (this.path.length > 0){
				this.unitCollection.moveIndiv(this.path[0][0][0], this.path[0][0][1]);
				debug ("switch to walking");
				this.state = "walking";
			} else {
				debug ("Attack Plan " +this.type +" " +this.name +" has arrived to destination.");
				// we must assume we've arrived at the end of the trail.
				this.state = "arrived";
			}
		}
		
	}


	// todo: re-implement raiding
	if (this.state === "arrived"){
		// let's proceed on with whatever happens now.
		// There's a ton of TODOs on this part.
		if (this.onArrivalReaction == "proceedOnTargets") {
			this.state = "";
			this.unitCollection.forEach( function (ent) { //}) {
				ent.stopMoving();
			});
		} else if (this.onArrivalReaction == "huntVillagers") {
			// let's get any villager and target them with a tactics manager
			var enemyCitizens = gameState.entities.filter(function(ent) {
					return (gameState.isEntityEnemy(ent) && ent.hasClass("Support") && ent.owner() !== 0  && ent.position());
				});
			var targetList = [];
			enemyCitizens.forEach( function (enemy) {
				if (inRange(enemy.position(), units.getCentrePosition(), 2500) && targetList.indexOf(enemy.id()) === -1)
					targetList.push(enemy.id());
			});
			if (targetList.length > 0)
			{
				this.tactics = new Tactics(gameState,HeadQuarters, this.idList,targetList);
				this.state = "huntVillagers";
			} else {
				this.state = "";
			}
		}
	}
	
	if (this.state === "" && gameState.ai.playedTurn % 3 === 0) {
		
		// Units attacked will target their attacker unless they're siege. Then we take another non-siege unit to attack them.
		for (var key in events) {
			var e = events[key];
			if (e.type === "Attacked" && e.msg) {
				if (IDs.indexOf(e.msg.target) !== -1) {
					var attacker = gameState.getEntityById(e.msg.attacker);
					var ourUnit = gameState.getEntityById(e.msg.target);
					
					if (attacker && attacker.position() && attacker.hasClass("Unit") && attacker.owner() != 0 && attacker.owner() != PlayerID) {
						if (ourUnit.hasClass("Siege"))
						{
							var help = this.unitCollection.filter(Filters.and(Filters.not(Filters.byClass("Siege")),Filters.isIdle()));
							if (help.length === 0)
								help = this.unitCollection.filter(Filters.not(Filters.byClass("Siege")));
							if (help.length > 0)
							{
								help.toEntityArray()[0].attack(attacker.id());
							}
						} else {
							ourUnit.attack(attacker.id());
						}
					}
				}
			}
		}
		
		
		var enemyUnits = gameState.getEnemyEntities().filter(Filters.and(Filters.byOwner(this.targetPlayer), Filters.byClass("Unit")));
		var enemyStructures = gameState.getEnemyEntities().filter(Filters.and(Filters.byOwner(this.targetPlayer), Filters.byClass("Structure")));

		if (this.unitCollUpdateArray === undefined || this.unitCollUpdateArray.length === 0)
		{
			this.unitCollUpdateArray = this.unitCollection.toEntityArray();
		} else {
			// Let's check a few units each time we update. Currently 10
			for (var check = 0; check < Math.min(this.unitCollUpdateArray.length,10); check++)
			{
				var ent = this.unitCollUpdateArray[0];
				
				// if the unit is not in my territory, make it move.
				var territoryMap = Map.createTerritoryMap(gameState);
				if (territoryMap.point(ent.position()) - 64 === PlayerID)
					ent.move((this.targetPos[0] + ent.position()[0])/2,(this.targetPos[1] + ent.position()[1])/2);
				// update it.
				var needsUpdate = false;
				if (ent.isIdle())
					needsUpdate = true;
				// always update siege units, they tend to target nothing we want.
				if (ent.hasClass("Siege"))
					needsUpdate = true;
				else if (ent.unitAIOrderData() && ent.unitAIOrderData()["target"] && gameState.getEntityById(ent.unitAIOrderData()["target"]).hasClass("Structure"))
					needsUpdate = true; // try to make it attack a unit instead
				
				if (needsUpdate)
				{
					//warn ("Entity " +ent.id() + ", a " + ent._templateName + " needs updating.");
					var mStruct = enemyStructures.filter(function (enemy) { //}){
						if (!enemy.position() || (enemy.hasClass("StoneWall") && ent.canAttackClass("StoneWall"))) {
							return false;
						}
						if (SquareVectorDistance(enemy.position(),ent.position()) > 2000) {
							return false;
						}
						return true;
					});
					var mUnit = enemyUnits.filter(function (enemy) { //}){
						if (!enemy.position()) {
							return false;
						}
						if (SquareVectorDistance(enemy.position(),ent.position()) > 2000) {
							return false;
						}
						return true;
					});
					var isGate = false;
					mUnit = mUnit.toEntityArray();
					mStruct = mStruct.toEntityArray();
					if (ent.hasClass("Siege")) {
						mStruct.sort(function (structa,structb) { //}){
							var vala = structa.costSum();
							if (structa.hasClass("Gates") && ent.canAttackClass("StoneWall"))	// we hate gates
							{
								isGate = true;
								vala += 10000;
							} else if (structa.hasClass("ConquestCritical"))
								vala += 100;
							var valb = structb.costSum();
							if (structb.hasClass("Gates") && ent.canAttackClass("StoneWall"))	// we hate gates
							{
								isGate = true;
								valb += 10000;
							} else if (structb.hasClass("ConquestCritical"))
								valb += 100;
							//warn ("Structure " +structa.genericName() + " is worth " +vala);
							//warn ("Structure " +structb.genericName() + " is worth " +valb);
							return (valb - vala);
						});
						
						if (mStruct.length !== 0) {
							if (isGate)
								ent.attack(mStruct[0].id());
							else
							{
								var rand = Math.floor(Math.random() * mStruct.length*0.1);
								ent.attack(mStruct[+rand].id());
								//debug ("Siege units attacking a structure from " +mStruct[+rand].owner() + " , " +mStruct[+rand].templateName());
							}
						} else if (SquareVectorDistance(self.targetPos, ent.position()) > 900 ){
							//debug ("Siege units moving to " + uneval(self.targetPos));
							ent.move((self.targetPos[0] + ent.position()[0])/2,(self.targetPos[1] + ent.position()[1])/2);
						}
					} else {
						if (mUnit.length !== 0 && !isGate) {
							var rand = Math.floor(Math.random() * mUnit.length*0.99);
							ent.attack(mUnit[(+rand)].id());
							//debug ("Units attacking a unit from " +mUnit[+rand].owner() + " , " +mUnit[+rand].templateName());
						} else if (mStruct.length !== 0) {
							mStruct.sort(function (structa,structb) { //}){
								var vala = structa.costSum();
								if (structa.hasClass("Gates") && ent.canAttackClass("StoneWall"))	// we hate gates
								{
									isGate = true;
									vala += 10000;
								} else if (structa.hasClass("ConquestCritical"))
									vala += 100;
								var valb = structb.costSum();
								if (structb.hasClass("Gates") && ent.canAttackClass("StoneWall"))	// we hate gates
								{
									isGate = true;
									valb += 10000;
								} else if (structb.hasClass("ConquestCritical"))
									valb += 100;
								return (valb - vala);
							});
							if (isGate)
								ent.attack(mStruct[0].id());
							else
							{
								var rand = Math.floor(Math.random() * mStruct.length*0.1);
								ent.attack(mStruct[+rand].id());
								//debug ("Units attacking a structure from " +mStruct[+rand].owner() + " , " +mStruct[+rand].templateName());
							}
						} else if (SquareVectorDistance(self.targetPos, ent.position()) > 900 ){
							//debug ("Units moving to " + uneval(self.targetPos));
							ent.move((self.targetPos[0] + ent.position()[0])/2,(self.targetPos[1] + ent.position()[1])/2);
						}
					}
				}
				
				this.unitCollUpdateArray.splice(0,1);
			}
		}
	}
	/*
	if (this.state === "huntVillagers")
	{
		this.tactics.eventMetadataCleanup(events,HeadQuarters);
		this.tactics.removeTheirDeads(HeadQuarters);
		this.tactics.removeMyDeads(HeadQuarters);
		if (this.tactics.isBattleOver())
		{
			this.tactics.disband(HeadQuarters,events);
			this.tactics = undefined;
			this.state = "";
			return 0;	// assume over
		} else
			this.tactics.reassignAttacks(HeadQuarters);
	}*/
	this.lastPosition = this.position;
	Engine.ProfileStop();
	
	return this.unitCollection.length;
};
CityAttack.prototype.totalCountUnits = function(gameState){
	var totalcount = 0;
	for (i in this.idList)
	{
		totalcount++;
	}
	return totalcount;
};
// reset any units
CityAttack.prototype.Abort = function(gameState){	
	this.unitCollection.forEach(function(ent) {
		ent.setMetadata(PlayerID, "role",undefined);
		ent.setMetadata(PlayerID, "subrole",undefined);
		ent.setMetadata(PlayerID, "plan",undefined);
	});
	for (unitCat in this.unitStat) {
		delete this.unitStat[unitCat];
		delete this.unit[unitCat];
	}
	delete this.unitCollection;
	gameState.ai.queueManager.removeQueue("plan_" + this.name);
};
