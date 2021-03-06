"use strict";

const _ = require('lodash');
const debug = require('debug')('taskmatic');
const denodeify = require('denodeify');
const timeparse = require('timeparse');
const mkdirp = require('mkdirp-promise');
const util = require('util');
const Engine = require('tingodb')();
const EventEmitter = require('events').EventEmitter;
const co = require('co');
const prettyms = require('pretty-ms');

const REQ_OPTS = "usage: new TaskMatic({dbPath:'/path/to/db-dir', cooldown:'5min'}); cooldown is optional, defaults to 60s";

module.exports = TaskMatic;

function TaskMatic (opts) {
  if (!opts) throw new Error(REQ_OPTS);
  if (!opts.dbPath) throw new Error(REQ_OPTS);
  this.tick = this.tick.bind(this);
  this.run = this.run.bind(this);
  this._dbPath = opts.dbPath;
  this._cooldown = timeparse(typeof opts.cooldown === 'undefined' ? '60s' : opts.cooldown); // default cooldown:  60s
  this._schedulePromises = [];
  this._tasks = {};
  this.debug = opts.noDebug ? function(){} : debug;
  this.debug("Cooldown: "+this._cooldown);
}

util.inherits(TaskMatic, EventEmitter);

TaskMatic.prototype.schedule = schedule;
TaskMatic.prototype.db = getDb;
TaskMatic.prototype.start = start;
TaskMatic.prototype.tick = tick;
TaskMatic.prototype.run = co.wrap(run);
TaskMatic.prototype.report = co.wrap(report);
TaskMatic.prototype.finishSetup = finishSetup;

function start() {
  this.debug("startup");
  const self = this;
  return this.x().then(function() {
    process.nextTick(self.tick);
  });
}

function finishSetup () {
  if (!this._schedulePromises) return Promise.resolve();

  const self = this;
  return (Promise
    .all(this._schedulePromises)
    .then(function () {
      delete self._schedulePromises;
    }).catch(function (error) {
      const e = new Error("Error on Startup!");
      e.stack = e.stack + "\n--------- original error: \n" + error.stack;
      throw e;
    }));
}

function * report() {
  const self = this;
 // yield this.finishSetup();
  const db = yield this.db();
  const all = (yield db.find({}));
  return all;
}

function * run(taskId) {
  this.debug("Running Task", taskId);
  yield this.finishSetup();
  const db = yield this.db();
  this.emit("task-will-start", taskId);
  let task;
  try {
    task = yield db.findOne({id:taskId});
  } catch (e) {
    this.emit("task-find-error", taskId, e);
    return;
  }
  if (task.status === 'running') {
    this.emit("task-cancelled", task, 'Already Running');
    return;
  }
  this.emit("task-start", task);
  const start = new Date();
  yield db.update({id:taskId}, {$set:{last: start, status: 'running', lastEnd: null}}, {});
  task = yield db.findOne({id:taskId});
  const diff = task.maxAge - task.minAge;
  const delay = task.maxAge === task.minAge ? task.minAge : Math.floor(Math.random() * diff);
  const context = {task:task, id:taskId};
  try {
    const result = yield this._tasks[taskId].call(context);
    const end = new Date();
    const elapsed = end - start;
    yield db.update({id:taskId}, {$set: {
      lastStatus: 'success',
      lastError: null,
      lastEnd: new Date(),
      lastElapsed: prettyms(elapsed),
      lastResult: JSON.stringify(result, null, 2),
      next: new Date(Date.now() + delay),
      status: 'waiting'
    }}, {});
    task = yield db.findOne({id:taskId});
    this.emit('task-success', task);
  } catch (e) {
    const end = new Date();
    const elapsed = end - start;
    console.error("error", e);
    yield db.update({id:taskId}, {$set: {
      lastStatus: 'error',
      lastError: e.stack,
      lastEnd: new Date(),
      lastElapsed: prettyms(elapsed),
      lastResult: null,
      next: new Date(Date.now() + delay),
      status: 'waiting'
    }}, {});
    task = yield db.findOne({id:taskId});
    this.emit('task-error', task, e);
  }
  this.emit("task-end", taskId, task);
}

function tick() {
  this.debug("tick", new Date().toISOString());
  const self = this;
  const again = function() {
    setTimeout(self.tick, self._cooldown);
  };
  this.db().then(function(db) {
    const now = new Date();
    return (db
      .find({
        'next': {$lt: now},
        'status': {$ne: 'running'}
      })
      .then(function(results) {
        results.forEach(function(t) {
          self.run(t.id);
        });
      })
      .catch(function(e) {
        console.error("Error: ", e.stack);
      })
      .then(again)
    );
  });
}

function parseSpec (id, spec) {
  const realSpec = {
    id: id
  };

  let match;
  if (/^\d+\w+$/.test(spec)) {
    realSpec.minAge = realSpec.maxAge = timeparse(spec);
  } else if ((match = /^(\d+\w+) \+\/- (\d+\w+)/.exec(spec))) {
    const base = timeparse(match[1]);
    const mod = timeparse(match[2]);
    realSpec.minAge = base - mod;
    realSpec.maxAge = base + mod;
  } else if ((match = /^(\d+\w+) - (\d+\w+)/.exec(spec))) {
    realSpec.minAge = timeparse(match[1]);
    realSpec.maxAge = timeparse(match[2]);
  } else {
    return Promise.reject(new Error("Can't parse run spec: "+spec));
  }

  return Promise.resolve(realSpec);
}

function schedule (id, spec, run) {
  const self = this;
  const promise = (Promise.all([
    this.db(),
    parseSpec(id, spec)
  ])
  .then(function(results) {
    const db = results[0];
    const taskSpec = results[1];
    if (self._tasks[id]) throw new Error("Task "+id+" defined multiple times!");
    self._tasks[id] = run;

    return (db.findOne({id:taskSpec.id})
      .catch(function (e) {
        return {};
      })
      .then(function (task) {
        task = _.extend({}, task, taskSpec);
        if (!task.last) task.last = null; // make it an explicit null rather than undefined
        if (!task.lastStatus) task.lastStatus = 'no prior run information';
        if (!task.next) {
          // assign a random time between its min/max ages, assuming it is currently expired
          const next = Date.now() + Math.floor(Math.random() * (task.maxAge - task.minAge));
          task.next = new Date(next);
        }
        if (task.status !== 'waiting' && task.last !== null) {
          task.lastStatus = 'interrupted by program execution ending';
        }
        task.status = 'waiting';
        return task;
      })
      .then(function (task) {
        self.debug("Register", task);
        self.emit('task-registered', task);
        return db.update({id:id}, task, {upsert:true});
      })
    );

  }));
  this._schedulePromises.push(promise);
}

function getDb () {
  const self = this;
  if (this._db) return Promise.resolve(this._db);
  if (! this._dbPromise) {
    this._dbPromise = mkdirp(this._dbPath)
      .then(function() {
        const _t = self._tingo = new Engine.Db(self._dbPath, {});
        const _c = self._coll = _t.collection("tasks");
        self._db = {
          insert: denodeify(_c.insert.bind(_c)),
          find: function(pattern) {
            return new Promise(function(accept, reject) {
              _c.find(pattern).toArray(function(error, result) {
                if (error) return reject(error);
                return accept(result);
              });
            });
          },
          findOne: denodeify(_c.findOne.bind(_c)),
          update: denodeify(_c.update.bind(_c))
        };
        return self._db;
      });
  }
  return this._dbPromise;

}
