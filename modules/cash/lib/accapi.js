var async = require('async');
var _ = require('underscore');
var extend = require('node.extend');
var SkilapError = require("skilap-utils").SkilapError;

module.exports.getAccount = function (token, id, cb) {
	var self = this;
	async.series ([
		function start(cb) {
			async.parallel([
				function (cb) { self._coreapi.checkPerm(token,["cash.view"],cb) },
				function (cb) { self._waitForData(cb) }
			],cb);
		},
		function get(cb) {
			self._cash_accounts.get(id, function (err, acc) {
				if (err) cb(err);
				cb(null, acc);
			},
			true);
		}], function end(err, result) {
			if (err) return cb(err);
			cb(null, result[1]);
		}
	)
}

module.exports.getAllAccounts = function (token, cb) {
	var self = this;
	async.series ([
		function start(cb) {
			async.parallel([
				function (cb) { self._coreapi.checkPerm(token,["cash.view"],cb) },
				function (cb) { self._waitForData(cb) }
			],cb);
		}, 
		function get(cb) {
			var accounts = [];
			self._cash_accounts.scan(function (err, key, acc) {
				if (err) cb(err);
				if (key) accounts.push(acc);
					else cb(null, accounts);
				},
			true);
		}], function end(err, results) {
			if (err) return cb(err);
			cb(null, results[1]);
		}
	)
}

module.exports.getChildAccounts = function(token, parentId, cb) {
	var self = this;
	async.series ([
		function start(cb) {
			async.parallel([
				function (cb) { self._coreapi.checkPerm(token,["cash.view"],cb) },
				function (cb) { self._waitForData(cb) }
			],cb);
		}, 
		function get(cb) {
			self._cash_accounts.find({parentId: {$eq: parentId}}).all(function (err, accounts) {
				if (err) return cb(err);
				cb(null, _(accounts).map(function (e) {return e.value;}));
			});
		}
		], function end(err, results) {
			if (err) return cb(err);
			cb(null, results[1]);
		}
	)
}

module.exports.getAccountByPath = function (token,path,cb) {		
	var self = this;
	async.series ([
		function start(cb) {
			async.parallel([
				function (cb) { self._coreapi.checkPerm(token,["cash.view"],cb) },
				function (cb) { self._waitForData(cb) }
			],cb);
		}, 
		function get(cb) {
			var newAccId = null;
			_.forEach(self._stats, function (accStat,key) {
				if (accStat.path == path)
					newAccId = key;
			});				
			if (newAccId==null)
				process.nextTick(function () { cb(new SkilapError("No such account","NO_SUCH_ACCOUNT")); });
			else 
				process.nextTick(function () { cb(null, newAccId); });
		}
		], function end(err, results) {
			if (err) return cb(err);
			self.getAccount(token,results[1],cb);
		}
	)
}

module.exports.getSpecialAccount = function (token,type,cmdty,cb) {
	var self = this;
	var name = "";
	if (type == "disballance")
		name = self._ctx.i18n(token, 'cash', 'Disballance') + "_" + cmdty.id;
	else
		return cb(new Error("Unsupported type"));
	
	self.getAccountByPath(token,name, function (err, acc) {
		if (err) {
			if (err.skilap && err.skilap.subject == "NO_SUCH_ACCOUNT") {
				// create one
				var acc = {"parentId":0,"cmdty":cmdty,"name":name,"type":"EQUITY"}
				return self.saveAccount(token,acc,cb);
			} else
				return cb(err); // unknown error
		}
		if (!_(acc.cmdty).isEqual(cmdty)) 
			return cb(new Error("Special account exist, but has wrong currency"))
		if (acc.type!="EQUITY") 
			return cb(new Error("Special account exist, but has wrong type"))			
		cb(null, acc)
	})
}

module.exports.getAccountInfo = function (token, accId, details, cb) {
	var self = this;
	var accInfo = null;
	var accStats = null
	var assInfo = null;
	async.series ([
		function (cb) {
			async.parallel([
				function (cb) { self._coreapi.checkPerm(token,["cash.view"],cb) },
				function (cb) { self._waitForData(cb) }
			],cb);
		}, 
		function (cb) {
			accStats = self._stats[accId];
			if (accStats==null)
				return cb(new Error("Invalid account Id: "+accId));
			cb();
		},
		function (cb) {
			if (!_(details).include("verbs"))
				return cb();
			self.getAssetsTypes(token, function (err, assets) {
				if (err) return cb(err);
				accInfo = _(assets).find(function (e) { return e.value == accStats.type; } );
				if (accInfo==null)
					return cb(new Error("Wrong account type"));
				cb();
			})
		},
		function (cb) {
			if (!_(details).include("act"))
				return cb();
			self.getAssetInfo(token,accStats.type, function (err, info) {
				if (err) return cb(err);
				assInfo = info;
				cb();
			})
		},		
		function (cb) {
			var res = {};
			res.id = accId;
			_.forEach(details, function (val) {
				switch(val) {
					case 'value':
						res.value = accStats.value;
						break;
					case 'count':
						res.count = accStats.count;
						break;
					case 'path':
						res.path = accStats.path;
						break;
					case 'verbs':
						res.recv = accInfo.recv;
						res.send = accInfo.send;
						break;
					case 'act':
						res.act = assInfo.act
				}
			});				
			cb(null, res);
		}], function (err, results) {
			if (err) return cb(err);
			cb(null,results[4]);
		}
	)
}

module.exports.deleteAccount = function (token, accId, options, cb){
	var self = this;
	async.series([
		function start(cb) {
			async.parallel([
				function (cb) { self._coreapi.checkPerm(token,["cash.edit"],cb) },
				function (cb) { self._waitForData(cb) }
			],cb);
		}, 
		function processTransactions(cb) {
			var updates = [];
			self._cash_transactions.scan(function (err, key, tr) {
				if (err) return cb(err);
				if (key==null) {
					// scan done, propagate changes
					async.forEach(updates, function (u, cb) {
						self._cash_transactions.put(u.key, u.tr, cb);
					}, cb)
				} else {
					// collecte transactions that need to be altered
					_(tr.splits).forEach(function (split) {							
						if (split.accountId == accId) {
							if (options.newParent) {
								split.accountId = options.newParent;
								updates.push({key:key,tr:tr});
							} else
								updates.push({key:key,tr:null});
						}
					});
				}
			},true);
		},
		function processSubAccounts(cb){
			if (options.newSubParent) {
				self.getChildAccounts(token, accId, function(err, childs){
					if (err) return cb(err);
					async.forEach(childs, function(ch,cb) {
						ch.parentId = options.newSubParent;
						self._cash_accounts.put(ch.id, ch, cb);
					},cb);
				});
			} else {
				var childs = [];
				async.waterfall([
					function(cb){
						self._getAllChildsId(token, accId, childs, cb);
					},
					function (cb){
						var updates = [];
						self._cash_transactions.scan(function (err, key, tr) {
							if (err) return cb(err);
							if (key==null) {
								// scan done, propagate changes
								async.forEach(updates, function (u, cb) {
									self._cash_transactions.put(u.key, u.tr, cb);
								}, cb)
							} else {								
								// collect transactions to alter
								_(tr.splits).forEach(function (split) {
									if (_(childs).indexOf(split.accountId) > -1){
										if (options.newSubAccTrnParent) {
											split.accountId = options.newSubAccTrnParent;
											updates.push({key:key,tr:tr});											
										} else
											updates.push({key:key,tr:null});
									}
								})
							};
						},true);
					},
					function (cb) {
						async.forEach(childs, function (ch, cb) {
							self._cash_accounts.put(ch, null, cb);
						},cb);
					}
				],cb);
			}
		},
		function deleteAcc(cb) {
			self._cash_accounts.put(accId, null, cb);
		}
	], function (err) {
		if (err) return cb(err);
		self._calcStats(function () {})
		cb(null);
	});
}

module.exports._getAllChildsId = function (token, parentId, buffer, cb) {
	var self = this;
	async.waterfall([
		function (cb) { self.getChildAccounts(token, parentId,cb) },
		function(childs, cb){
			async.forEach(childs, function (ch, cb) {
				buffer.push(ch.id);
				self._getAllChildsId(token, ch.id, buffer, cb);
			}, cb);
		}
	],cb);
}

module.exports.clearAccounts = function (token, ids, cb) {
	var self = this;
	async.series ([
		function (cb) {
			async.parallel([
				function (cb) { self._coreapi.checkPerm(token,["cash.edit"],cb) },
				function (cb) { self._waitForData(cb) }
			],cb);
		},
		function (cb) {
			self._cash_accounts.clear(cb);
		} 
	], function (err) {
		if (err) return cb(err);
		self._calcStats(function () {})
		cb(null);
	});
}

module.exports.importAccounts = function  (token, accounts, cb) {
	var self = this;
	async.series ([
		function (cb) {
			async.parallel([
				function (cb) { self._coreapi.checkPerm(token,["cash.edit"],cb) },
				function (cb) { self._waitForData(cb) }
			],cb);
		},
		function (cb) {
			async.forEachSeries(accounts, function (e, cb) {
				self._cash_accounts.put(e.id,e,cb);
			},cb);
		}, 
	], function (err) {
		if (err) return cb(err);
		self._calcStats(function () {})
		cb(null);
	})
}

module.exports.getDefaultAccounts = function (token, cmdty, cb){
	var self = this;
	var ctx = self._ctx;
	var accounts = [
		{name:ctx.i18n(token, 'cash', 'Cash'), type:'CASH', ch:[ctx.i18n(token, 'cash', 'My wallet')]},
		{name:ctx.i18n(token, 'cash', 'Bank'), type:'BANK', ch:[ctx.i18n(token, 'cash', 'My account')]},
		{name:ctx.i18n(token, 'cash', 'Credit Cards'), type:'CREDIT CARD', ch:[ctx.i18n(token, 'cash', 'My card')]},
		{name:ctx.i18n(token, 'cash', 'Income'), type:'INCOME', ch:[ctx.i18n(token, 'cash', 'Salary'), ctx.i18n(token, 'cash', 'Interest'), ctx.i18n(token, 'cash', 'Assets sale'), ctx.i18n(token, 'cash', 'Other')]},
		{name:ctx.i18n(token, 'cash', 'Car'), type:'EXPENSE', ch:[ctx.i18n(token, 'cash', 'Fuel'), ctx.i18n(token, 'cash', 'Insurance'), ctx.i18n(token, 'cash', 'Service'), ctx.i18n(token, 'cash', 'Repair'), ctx.i18n(token, 'cash', 'Other')]},
		{name:ctx.i18n(token, 'cash', 'Life'), type:'EXPENSE', ch:[ctx.i18n(token, 'cash', 'Food'), ctx.i18n(token, 'cash', 'Drugs'), ctx.i18n(token, 'cash', 'Transport'), ctx.i18n(token, 'cash', 'Other')]},
		{name:ctx.i18n(token, 'cash', 'Utilities'), type:'EXPENSE', ch:[ctx.i18n(token, 'cash', 'Mobile links'), ctx.i18n(token, 'cash', 'Fixed links'), ctx.i18n(token, 'cash', 'House'), ctx.i18n(token, 'cash', 'Education'), ctx.i18n(token, 'cash', 'Other')]},
		{name:ctx.i18n(token, 'cash', 'Hobby'), type:'EXPENSE', ch:[ctx.i18n(token, 'cash', 'Sport'), ctx.i18n(token, 'cash', 'Garden'), ctx.i18n(token, 'cash', 'Charuty'), ctx.i18n(token, 'cash', 'Other')]},
		{name:ctx.i18n(token, 'cash', 'Real assets'), type:'EXPENSE', ch:[ctx.i18n(token, 'cash', 'Transport'), ctx.i18n(token, 'cash', 'Furniture'), ctx.i18n(token, 'cash', 'Estate'), ctx.i18n(token, 'cash', 'Goods'), ctx.i18n(token, 'cash', 'Insurance'), ctx.i18n(token, 'cash', 'Other')]},
		{name:ctx.i18n(token, 'cash', 'Recreation'), type:'EXPENSE', ch:[ctx.i18n(token, 'cash', 'Travel'), ctx.i18n(token, 'cash', 'Pleasures'), ctx.i18n(token, 'cash', 'Food & drinks'), ctx.i18n(token, 'cash', 'Events'), ctx.i18n(token, 'cash', 'Other')]},
		{name:ctx.i18n(token, 'cash', 'Accidental'), type:'EXPENSE', ch:[ctx.i18n(token, 'cash', 'Stolen'), ctx.i18n(token, 'cash', 'Gifts'), ctx.i18n(token, 'cash', 'Bad debts'), ctx.i18n(token, 'cash', 'Other')]},
		{name:ctx.i18n(token, 'cash', 'Debts'), type:'EQUITY', ch:[ctx.i18n(token, 'cash', 'Friends')]}
	];

	var ret = [];
	async.forEachSeries(accounts, function(acc, cb) {
		self._ctx.getUniqueId(function(err, uniqId) {
			ret.push({parentId:0, cmdty:cmdty, name:acc.name, id:uniqId, type:acc.type});
			
			async.forEachSeries(acc.ch, function(name, cb) {
				self._ctx.getUniqueId(function(err, id) {
					ret.push({parentId:uniqId, cmdty:cmdty, name:name, id:id, type:acc.type});
					cb();
				});
			}, cb);
		});
	}, function(err) {
		cb(err, ret);
	});
}

module.exports.restoreToDefaults = function (token, cmdty, type, cb){
	var self = this;
	async.waterfall([
		function start(cb) {
			async.parallel([
				function (cb) { self._coreapi.checkPerm(token,["cash.edit"],cb) },
				function (cb) { self._waitForData(cb) }
			],cb);
		}, 
		function (results ,cb) {
			self._cash_prices.clear(cb);
		},
		function (cb) {
			self._cash_transactions.clear(cb);
		},
		function (cb){
			self._cash_accounts.clear(cb);
		},
		function (cb) {
			if (type == "default")
				self.getDefaultAccounts(token, cmdty, cb);
			else 
				cb(null, []);
		},
		function (accounts, cb) {
			async.forEachSeries(accounts, function (e, cb) {
				self._cash_accounts.put(e.id,e,cb);
			},cb);
		}
	], function (err) {
		if (err) return cb(err);
		self._calcStats(function () {});
		cb(null);
	});
}

module.exports.getAssetsTypes = function (token,cb) {
	var self = this;	
	var types = [
			{value:"BANK", name:self._ctx.i18n(token, 'cash', 'Bank'),act:1,recv:self._ctx.i18n(token, 'cash', 'Deposited'),send:self._ctx.i18n(token, 'cash', 'Withdrawal')},
			{value:"CASH", name:self._ctx.i18n(token, 'cash', 'Cash'),act:1,recv:self._ctx.i18n(token, 'cash', 'Received'),send:self._ctx.i18n(token, 'cash', 'Spent')},
			{value:"ASSET", name:self._ctx.i18n(token, 'cash', 'Asset'),act:1,recv:self._ctx.i18n(token, 'cash', 'Received'),send:self._ctx.i18n(token, 'cash', 'Spent')},
			{value:"CREDIT", name:self._ctx.i18n(token, 'cash', 'Credit card'),act:1,recv:self._ctx.i18n(token, 'cash', 'Received'),send:self._ctx.i18n(token, 'cash', 'Spent')},
			{value:"LIABILITY", name:self._ctx.i18n(token, 'cash', 'Liability'),act:-1,recv:self._ctx.i18n(token, 'cash', 'Received'),send:self._ctx.i18n(token, 'cash', 'Spent')},
			{value:"STOCK", name:self._ctx.i18n(token, 'cash', 'Stock'),act:1,recv:self._ctx.i18n(token, 'cash', 'Received'),send:self._ctx.i18n(token, 'cash', 'Spent')},
			{value:"MUTUAL", name:self._ctx.i18n(token, 'cash', 'Mutual found'),act:1,recv:self._ctx.i18n(token, 'cash', 'Received'),send:self._ctx.i18n(token, 'cash', 'Spent')},
			{value:"CURENCY", name:self._ctx.i18n(token, 'cash', 'Curency'),act:1,recv:self._ctx.i18n(token, 'cash', 'Received'),send:self._ctx.i18n(token, 'cash', 'Spent')},
			{value:"INCOME", name:self._ctx.i18n(token, 'cash', 'Income'),act:-1,recv:self._ctx.i18n(token, 'cash', 'Received'),send:self._ctx.i18n(token, 'cash', 'Spent')},
			{value:"EXPENSE", name:self._ctx.i18n(token, 'cash', 'Expense'),act:1,recv:self._ctx.i18n(token, 'cash', 'Received'),send:self._ctx.i18n(token, 'cash', 'Spent')},
			{value:"EQUITY", name:self._ctx.i18n(token, 'cash', 'Equity'),act:1,recv:self._ctx.i18n(token, 'cash', 'Received'),send:self._ctx.i18n(token, 'cash', 'Spent')},
			{value:"RECIEVABLE", name:self._ctx.i18n(token, 'cash', 'Recievable'),act:-1,recv:self._ctx.i18n(token, 'cash', 'Received'),send:self._ctx.i18n(token, 'cash', 'Spent')},
			{value:"PAYABLE", name:self._ctx.i18n(token, 'cash', 'Payable'),act:1,recv:self._ctx.i18n(token, 'cash', 'Received'),send:self._ctx.i18n(token, 'cash', 'Spent')}
		]
	cb (null, types);
}

module.exports.saveAccount = function (token, account, cb) {
	var self = this;
	async.waterfall ([
		function start(cb) {
			async.parallel([
				function (cb) { self._coreapi.checkPerm(token,["cash.edit"],cb) },
				function (cb) { self._waitForData(cb) }
			],cb);
		},
		function (t, cb) {
			if (account.id)
				cb(null, account.id);
			else
				self._ctx.getUniqueId(cb);
		},
		function get(id, cb) {
			account.id = id;
			self._cash_accounts.put(account.id, account, cb);
		}], function end(err, result) {
			if (err) return cb(err);
			self._calcStats(function () {})
			cb(null, account);
		}
	)
}

module.exports.getAllCurrencies = function(token,cb){
	var self = this;
	async.waterfall ([
		function (cb) {
			async.parallel([
				function (cb1) { self._coreapi.checkPerm(token,["cash.view"],cb1); },
				function (cb1) { self._waitForData(cb1); }
			],function(err){
				if (err) cb(err);			
				cb(null);
			});			
		}, 		
		function(cb){
			async.parallel({
				curr:function (cb1) {				
					self._ctx.i18n_getCurrencies(token, cb1);					
				},
				usedCurr:function (cb1) {
					var usedCurrencies = {};					
					self._cash_accounts.scan(function (err, key, acc) {						
						if (err) cb1(err);
						if (key){
							usedCurrencies[acc.cmdty.id] = acc.cmdty;
						}
						else cb1(null, usedCurrencies);
					},
					true);							
				}
			},function (err, result) {																	
				cb(err, result.curr,result.usedCurr);
			});			
		},
		function(currencies,usedCurrencies,cb){			
			_.forEach(currencies,function(curr){				
				curr.used = _.has(usedCurrencies, curr.iso) ? 1 : 0;				
			});
			cb(null,currencies);
		}
	], function(err, result) {		
			if (err) return cb(err);			
			cb(null, result);
		}
	);
	
}
