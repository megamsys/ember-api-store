import Ember from 'ember';
import Serializable from '../mixins/serializable';
import ApiError from '../models/error';
import { normalizeType } from '../utils/normalize';
import { applyHeaders } from '../utils/apply-headers';
import fetch from 'ember-api-store/utils/fetch';
import { urlOptions } from '../utils/url-options';

const { getOwner } = Ember;

export const defaultMetaKeys = ['actionLinks','createDefaults','createTypes','filters','links','pagination','resourceType','sort','sortLinks','type'];
export const neverMissing = ['error'];

var Store = Ember.Service.extend({
  defaultTimeout: 30000,
  defaultPageSize: 1000,
  baseUrl: '/v1',
  metaKeys: null,
  neverMissing: null,
  replaceActions: 'actionLinks',
  dropKeys: null,
  shoeboxName: 'ember-api-store',
  headers: null,

  arrayProxyClass: Ember.ArrayProxy,
  arrayProxyKey: 'content',
  arrayProxyOptions: null,

  // true: automatically remove from store after a record.delete() succeeds.  You might want to disable this if your API has a multi-step deleted vs purged state.
  removeAfterDelete: true,


  fastboot: Ember.computed(function() {
    return Ember.getOwner(this).lookup('service:fastboot');
  }),

  init() {
    this._super();
    console.log("=> [start] init:ember api store.")
    if (!this.get('metaKeys') )
    {
      this.set('metaKeys', defaultMetaKeys.slice());
    }

    if (!this.get('neverMissing') )
    {
      this.set('neverMissing', neverMissing.slice());
    }

    this._state = {
      cache: null,
      cacheMap: null,
      classCache: null,
      foundAll: null,
      findQueue: null,
      missingMap: null,
    };

    let fastboot = this.get('fastboot');
    if ( fastboot )
    {
      let name = this.get('shoeboxName');
      if ( fastboot.get('isFastBoot') )
      {
        fastboot.get('shoebox').put(name, this._state);
      }
      else
      {
        let box = fastboot.get('shoebox').retrieve(name);
        if ( box )
        {
          this._state = box;
        }
      }
    }

    this.reset();
    console.log("=> [end] init:ember api store.")
  },

  // All the saved state goes in here
  _state: null,

  // You can observe this to tell when a reset() happens
  generation: 0,

  // Synchronously get record from local cache by [type] and [id].
  // Returns undefined if the record is not in cache, does not talk to API.
  getById(type, id) {
    type = normalizeType(type);
    var group = this._groupMap(type);
    return group[id];
  },

  // Synchronously returns whether record for [type] and [id] is in the local cache.
  hasRecordFor(type, id) {
    return !!this.getById(type,id);
  },

  // Synchronously returns whether this exact record object is in the local cache
  hasRecord(obj) {
    if ( !obj ) {
      return false;
    }

    var type = normalizeType(obj.get('type'));
    var group = this._groupMap(type);
    return group[obj.get('id')] === obj;
  },

  isCacheable(opt) {
    return !opt || (opt.depaginate && !opt.filter && !opt.include);
  },

  // Asynchronous, returns promise.
  // find(type[,null, opt]): Query API for all records of [type]
  // find(type,id[,opt]): Query API for record [id] of [type]
  // opt:
  //  filter: Filter by fields, e.g. {field: value, anotherField: anotherValue} (default: none)
  //  include: Include link information, e.g. ['link', 'anotherLink'] (default: none)
  //  forceReload: Ask the server even if the type+id is already in cache. (default: false)
  //  limit: Number of reqords to return per page (default: 1000)
  //  depaginate: If the response is paginated, retrieve all the pages. (default: true)
  //  headers: Headers to send in the request (default: none).  Also includes ones specified in the model constructor.
  //  url: Use this specific URL instead of looking up the URL for the type/id.  This should only be used for bootstraping schemas on startup.
  find(type, id, opt) {
    console.log("=> [start] find [" + type + "]," + id);

    type = normalizeType(type);
    opt = opt || {};
    opt.depaginate = opt.depaginate !== false;

    if ( !id && !opt.limit )
    {
      opt.limit = this.defaultPageSize;
    }

    if ( !type )
    {
      return Ember.RSVP.reject(new ApiError('type not specified'));
    }

    // If this is a request for all of the items of [type], then we'll remember that and not ask again for a subsequent request
    var isCacheable = this.isCacheable(opt);
    opt.isForAll = !id && isCacheable;

    console.log("=> [info] find [" + type + "] isCacheable=" + isCacheable + ",forceReload=" + opt.forceReload);
    console.log("=> [info] find [" + type + "] isForAll=" +  opt.isForAll + ",foundAll=" + this._state.foundAll[type]);
    // See if we already have this resource, unless forceReload is on.
    if ( opt.forceReload !== true )
    {
      if ( opt.isForAll && this._state.foundAll[type] )
      {
        return Ember.RSVP.resolve(this.all(type),'Cached find all '+type);
      }
      else if ( isCacheable && id )
      {
        var existing = this.getById(type,id);
        if ( existing )
        {
          return Ember.RSVP.resolve(existing,'Cached find '+type+':'+id);
        }
      }
    }

    // If URL is explicitly given, go straight to making the request.  Do not pass go, do not collect $200.
    // This is used for bootstraping to load the schema initially, and shouldn't be used for much else.
    if ( opt.url )
    {
      console.log("=> [info] find [" + type + "] url=" + opt.url);

      return this._findWithUrl(opt.url, type, opt);
    }
    else
    {
      // Otherwise lookup the schema for the type and generate the URL based on it.
      return this.find('schema', type, {url: 'schemas/'+encodeURIComponent(type)}).then((schema) => {
        var url = schema.linkFor('collection') + (id ? '/'+encodeURIComponent(id) : '');
        console.log("=> [info] find [" + type + "] schema url=" + url);
        return this._findWithUrl(url, type, opt);
      });
    }
  },

  // Returns a 'live' array of all records of [type] in the cache.
  all(type) {
    type = normalizeType(type);
    console.log("=> [start] all [" + type + "]");
    var group = this._group(type);
    console.log("=> [info] all [" + type + "] group=" + group);
    return this._createArrayProxy(group);
  },

  haveAll(type) {
    type = normalizeType(type);
    console.log("=> [start] haveAll [" + type + "] foundAll=" + this._state.foundAll[type]);
    return this._state.foundAll[type];
  },

  // find(type) && return all(type)
  findAll(type, opt) {
    type = normalizeType(type);
    console.log("=> [start] findAll [" + type + "]");

    opt = opt || {};

    if ( this.haveAll(type) && opt.forceReload !== true )
    {
      return Ember.RSVP.resolve(this.all(type),'All '+ type + ' already cached');
    }
    else
    {
      console.log("=> [info] findAll [" + type + "] not haveAll");
      return this.find(type, undefined, opt).then(() => {
        return this.all(type);
      });
    }
  },

  normalizeUrl(url, includingAbsolute=false) {
    var origin = window.location.origin;

    // Make absolute URLs to ourselves root-relative
    if ( includingAbsolute && url.indexOf(origin) === 0 )
    {
      url = url.substr(origin.length);
    }

    // Make relative URLs root-relative
    if ( !url.match(/^https?:/) && url.indexOf('/') !== 0 )
    {
      url = this.get('baseUrl').replace(/\/\+$/,'') + '/' + url;
    }

    return url;
  },

  // Makes an AJAX request and returns a promise that resolves to an object
  // This is separate from request() so it can be mocked for tests, or if you just want a basic AJAX request.
  rawRequest(opt) {
    opt.url = this.normalizeUrl(opt.url);
    opt.headers = this._headers(opt.headers);
    opt.processData = false;
    if ( typeof opt.dataType === 'undefined' )
    {
      opt.dataType = 'text'; // Don't let jQuery JSON parse
    }

    if ( opt.timeout !== null && !opt.timeout )
    {
      opt.timeout = this.defaultTimeout;
    }

    if ( opt.data )
    {
      if ( !opt.contentType )
      {
        opt.contentType = 'application/json';
      }

      if ( Serializable.detect(opt.data) )
      {
        opt.data = JSON.stringify(opt.data.serialize());
      }
      else if ( typeof opt.data === 'object' )
      {
        opt.data = JSON.stringify(opt.data);
      }
    }

    return fetch(opt.url, opt);
  },

  // Makes an AJAX request that resolves to a resource model
  request(opt) {
    opt.url = this.normalizeUrl(opt.url);
    opt.depaginate = opt.depaginate !== false;

    console.log("=> [start] request [" + opt.url + "]");

    if ( this.mungeRequest ) {
      opt = this.mungeRequest(opt);
    }

    console.log("=> [info] request [" + opt.url + "] munged="+ JSON.stringify(opt));

    return this.rawRequest(opt).then((xhr) => {
      console.log("=> [info] request [" + opt.url + "] success");
      return this._requestSuccess(xhr,opt);
    }).catch((xhr) => {
      return this._requestFailed(xhr,opt);
    });
  },

  // Forget about all the resources that hae been previously remembered.
  reset() {
    var cache = this._state.cache;
    if ( cache )
    {
      Object.keys(cache).forEach((key) => {
        if ( cache[key] && cache[key].clear ) {
          cache[key].clear();
        }
      });
    }
    else
    {
      this._state.cache = {};
    }

    var foundAll = this._state.foundAll;
    if ( foundAll )
    {
      Object.keys(foundAll).forEach((key) => {
        foundAll[key] = false;
      });
    }
    else
    {
      this._state.foundAll = {};
    }

    this._state.cacheMap = {};
    this._state.findQueue = {};
    this._state.classCache = [];
    this._state.missingMap = {};
    this.incrementProperty('generation');
  },

  resetType(type) {
    type = normalizeType(type);
    var group = this._group(type);
    this._state.foundAll[type] = false;
    this._state.cacheMap[type] = {};
    group.clear();
  },

  // ---------
  // Below here be dragons
  // ---------
  _createArrayProxy(content) {
    let data = {
      [this.arrayProxyKey]: content
    };

    console.log("=> [start] _createArrayProxy [" + this.arrayProxyKey + "] data="+ JSON.stringify(data));

    let opt = this.get('arrayProxyOptions')||{};
    Object.keys(opt).forEach((key) => {
      data[key] = opt[key];
    });
    console.log("=> [end] _createArrayProxy [" + this.arrayProxyKey + "] returndata="+ JSON.stringify(this.arrayProxyClass.create(data)));

    return this.arrayProxyClass.create(data);
  },

  _headers(perRequest) {
    console.log("=> [start] _headers [" + JSON.stringify(perRequest) + "]");

    let out = {
      'accept': 'application/json',
      'content-type': 'application/json',
    };

    applyHeaders(this.get('headers'), out);
    applyHeaders(perRequest, out);
    console.log("=> [start] _headers [" + JSON.stringify(out) + "]");
    return out;
  },

  _findWithUrl(url, type, opt) {
    var queue = this._state.findQueue;
    var cls = getOwner(this).lookup('model:'+type);
    console.log("=> [start] _findWithUrl [" + type + "] queue="+ JSON.stringify(queue) + ", claz=" + cls);

    url = urlOptions(url,opt,cls);

    // Collect Headers
    var newHeaders = {};

    if ( cls && cls.constructor.headers )
    {
      console.log("=> [info] _findWithUrl [" + type + "] claz_headers="+ JSON.stringify(cls.constructor.headers));
      applyHeaders(cls.constructor.headers, newHeaders, true);
    }
    console.log("=> [info] _findWithUrl [" + type + "] opt_headers="+ JSON.stringify(opt.headers));
    applyHeaders(opt.headers, newHeaders, true);
    // End: Collect headers
    console.log("=> [info] _findWithUrl [" + type + "] new_headers="+ JSON.stringify(newHeaders));

    var later;
    var queueKey = JSON.stringify(newHeaders) + url;

    console.log("=> [info] _findWithUrl [" + type + "] queueKey="+ JSON.stringify(queueKey));

    // check to see if the request is in the findQueue
    if (queue[queueKey]) {
      // get the filterd promise object
      var filteredPromise = queue[queueKey];
      let defer = Ember.RSVP.defer();
      filteredPromise.push(defer);
      later = defer.promise;
      console.log("=> [info] _findWithUrl [" + type + "] inside queue[queueKey]");
    } else { // request is not in the findQueue

      opt.url = url;
      opt.headers = newHeaders;

      console.log("=> [info] _findWithUrl [" + type + "] else queue[queueKey]");

      later = this.request(opt).then((result) => {
        console.log("=> [info] _findWithUrl [" + type + "] request="+ JSON.stringify(result));
        if ( opt.isForAll ) {
          this._state.foundAll[type] = true;
          console.log("=> [info] _findWithUrl [" + type + "] request.type="+ result.type);
          console.log("=> [info] _findWithUrl [" + type + "] request.Kind="+ result.Kind);
          console.log("=> [info] _findWithUrl [" + type + "] request.Kind is List="+ result.Kind.endsWith("List"));
          if ( opt.removeMissing && result.type === 'collection') {
            let all = this._group(type);
            let toRemove = [];
            all.forEach((obj) => {
              if ( !result.includes(obj) ) {
                toRemove.push(obj);
              }
            });

            toRemove.forEach((obj) => {
              this._remove(type, obj);
            });
          }
        }
        console.log("=> [info] _findWithUrl [" + type + "] request.resolve");
        this._finishFind(queueKey, result, 'resolve');
        return result;
      }, (reason) => {
        console.log("=> [info] _findWithUrl [" + type + "] request.reject="+reason);
        this._finishFind(queueKey, reason, 'reject');
        return Ember.RSVP.reject(reason);
      });

      // set the queue array to empty indicating we've had 1 promise already
      queue[queueKey] = [];
    }

    return later;

  },

  _finishFind(key, result, action) {
    var queue = this._state.findQueue;
    var promises = queue[key];
    console.log("=> [start] _finishFind [" + key + "] action="+ action +",queue=" + JSON.stringify(queue) + ",promises=" + JSON.stringify(promises));

    if (promises) {
      while (promises.length) {
        if (action === 'resolve') {
          console.log("=> [info] _finishFind [" + key + "] resolving promise");
          promises.pop().resolve(result);
        } else if (action === 'reject') {
          promises.pop().reject(result);
        }
      }
    }

    delete queue[key];
  },

  _requestSuccess(xhr,opt) {
    if ( xhr.status === 204 )
    {
      return;
    }

    console.log("=> [start] _requestSuccess [" + xhr + "]");
    if ( xhr.body && typeof xhr.body === 'object' )
    {
      Ember.beginPropertyChanges();

      let response = this._typeify(xhr.body);
      console.log("=> [info] _requestSuccess typeifyed [" + response + "]");
      delete xhr.body;
      Object.defineProperty(response, 'xhr', {value: xhr, configurable: true});
      Ember.endPropertyChanges();

      // Note which keys were included in each object
      if ( opt.include && opt.include.length && response.forEach )
      {
        response.forEach((obj) => {
          console.log("=> [info] _requestSuccess obj [" +obj + "]");
          obj.includedKeys = obj.includedKeys || [];
          obj.includedKeys.pushObjects(opt.include.slice());
          obj.includedKeys = obj.includedKeys.uniq();
        });
      }

      // Depaginate
      if ( opt.depaginate && typeof response.depaginate === 'function' )
      {
        return response.depaginate().then(function() {
          return response;
        }).catch((xhr) => {
          return this._requestFailed(xhr,opt);
        });
      }
      else
      {
        console.log("=> [end] _requestSuccess object [" + response + "]");
        return response;
      }
    }
    else
    {
      console.log("=> [end] _requestSuccess not object [" + xhr.body + "]");
      return xhr.body;
    }
  },

  _requestFailed(xhr,opt) {
    var body;

    if ( xhr.err )
    {
      if ( xhr.err === 'timeout' )
      {
        body = {
          code: 'Timeout',
          status: xhr.status,
          message: `API request timeout (${opt.timeout/1000} sec)`,
          detail: (opt.method||'GET') + ' ' + opt.url,
        };
      }
      else
      {
        body = {status: xhr.status, message: xhr.err};
      }

      return finish(body);
    }
    else if ( xhr.body && typeof xhr.body === 'object' )
    {
      Ember.beginPropertyChanges();
      let out = finish(this._typeify(xhr.body));
      Ember.endPropertyChanges();
      return out;
    }
    else
    {
      body = {status: xhr.status, message: xhr.body};
      return finish(body);
    }

    function finish(body) {
      if ( !ApiError.detectInstance(body) )
      {
        body = ApiError.create(body);
      }

      delete xhr.body;
      Object.defineProperty(body, 'xhr', {value: xhr, configurable: true});
      return Ember.RSVP.reject(body);
    }
  },

  // Get the cache array group for [type]
  _group(type) {
    type = normalizeType(type);
    var cache = this._state.cache;
    var group = cache[type];
    console.log("=> [start] _group [" + type + "] cache="+ cache + ",group="+ group);

    if ( !group )
    {
      group = [];
      cache[type] = group;
    }
    console.log("=> [end] _group [" + type + "] cache="+ cache + ",group="+ group);
    return group;
  },

  // Get the cache map group for [type]
  _groupMap(type) {
    type = normalizeType(type);
    var cache = this._state.cacheMap;
    var group = cache[type];
    if ( !group )
    {
      group = {};
      cache[type] = group;
    }

    return group;
  },

  // Add a record instance of [type] to cache
  _add(type, obj) {
    type = normalizeType(type);
    var group = this._group(type);
    var groupMap = this._groupMap(type);

    console.log("=> [start] _add [" + type + "]");

    group.pushObject(obj);
    groupMap[obj.id] = obj;

    if ( obj.wasAdded && typeof obj.wasAdded === 'function' )
    {
      obj.wasAdded();
    }
    console.log("=> [end] _add [" + type + "]");
  },

  // Add a lot of instances of the same type quickly.
  //   - There must be a model for the type already defined.
  //   - Instances cannot contain any nested other types (e.g. include or subtypes),
  //     (they will not be deserialzed into their correct type.)
  //   - wasAdded hooks are not called
  // Basically this is just for loading schemas faster.
  _bulkAdd(type, pojos) {
    type = normalizeType(type);
    var group = this._group(type);
    var groupMap = this._groupMap(type);
    var cls = getOwner(this).lookup('model:'+type);
    group.pushObjects(pojos.map((input)=>  {

      // actions is very unhappy property name for Ember...
      if ( this.replaceActions && typeof input.actions !== 'undefined')
      {
        input[this.replaceActions] = input.actions;
        delete input.actions;
      }

      // Schemas are special
      if ( type === 'schema' ) {
        input._id = input.id;
        input.id = normalizeType(input.id);
      }

      input.store = this;
      let obj =  cls.constructor.create(input);
      groupMap[obj.id] = obj;
      return obj;
    }));
  },

  // Remove a record of [type] from cache, given the id or the record instance.
  _remove(type, obj) {
    type = normalizeType(type);
    var group = this._group(type);
    var groupMap = this._groupMap(type);
    console.log("=> [start] _remove [" + type + "]");
    group.removeObject(obj);
    delete groupMap[obj.id];

    if ( obj.wasRemoved && typeof obj.wasRemoved === 'function' )
    {
      obj.wasRemoved();
    }
    console.log("=> [end] _remove [" + type + "]");
  },

  // Turn a POJO into a Model: {updateStore: true}
  _typeify(input, opt=null) {
    if ( !input || typeof input !== 'object')
    {
      // Simple values can just be returned
      console.log("=> [start] _typeify [input=" + input + "] is a simple value");
      return input;
    }

    if ( !opt ) {
      opt = {applyDefaults: false};
    }

    let type = Ember.get(input,'type');

    console.log("=> [info] _typeify [ember.get.type=" + type + "] input="+input);

    if ( Ember.isArray(input) )
    {
      // Recurse over arrays
      console.log("=> [info] _typeify input is an array, recurse typeify.");
      return input.map(x => this._typeify(x, opt));
    }
    else if ( !type )
    {
      // If it doesn't have a type then there's no sub-fields to typeify
      console.log("=> [info] _typeify must have a type.");
      return input;
    }

    type = normalizeType(type);

    console.log("=> [info] _typeify [type=" + type + "]");

    if ( type === 'collection')
    {
      console.log("=> [info] _typeify [type=" + type + "] is collection");
      return this.createCollection(input, opt);
    }
    else if ( !type )
    {
      console.log("=> [info] _typeify [type=" + type + "] is not collection");
      return input;
    }

    let rec = this.createRecord(input, opt);

    console.log("=> [info] _typeify [type=" + type + "] rec="+ rec);

    if ( !input.id || opt.updateStore === false ) {
      return rec;
    }

    // This must be after createRecord so that mangleIn() can change the baseType
    let baseType = rec.get('baseType');
    console.log("=> [info] _typeify [type=" + type + "] baseType="+ baseType);
    if ( baseType ) {
      baseType = normalizeType(baseType);

      // Only use baseType if it's different from type
      if ( baseType === type ) {
        baseType = null;
      }
    }


    let out = rec;

    console.log("=> [info] _typeify [type=" + type + "] id="+ rec.id);
    let cacheEntry = this.getById(type, rec.id);

    console.log("=> [info] _typeify [type=" + type + "] cacheEntry="+ cacheEntry);

    let baseCacheEntry;
    if ( baseType ) {
      baseCacheEntry = this.getById(baseType, rec.id);
    }

    console.log("=> [info] _typeify [type=" + type + "] baseCacheEntry="+ baseCacheEntry);

    if ( cacheEntry )
    {
      cacheEntry.replaceWith(rec);
      console.log("=> [info] _typeify [type=" + type + "] replaced cacheEntry="+ rec);
      out = cacheEntry;
    }
    else
    {
      this._add(type, rec);
      if ( baseType ) {
        this._add(baseType, rec);
      }
    }

    if ( type && !this.neverMissing.includes(type) ) {
      console.log("=> [info] _typeify [type=" + type + "] neverMissing_for_type="+ rec.id);
      Ember.run.next(this,'_notifyMissing', type, rec.id);

      if ( baseType && !this.neverMissing.includes(type) ) {
        console.log("=> [info] _typeify [type=" + type + "] baseType="+ baseType +",neverMissing_for_basetype="+ rec.id);
        Ember.run.next(this,'_notifyMissing', baseType, rec.id);
      }
    }

    console.log("=> [end] _typeify [" +type +"]" + JSON.stringify(out));
    return out;
  },

  // Create a collection: {key: 'data'}
  createCollection(input, opt) {
    Ember.beginPropertyChanges();
    let key = (opt && opt.key ? opt.key : 'data');
    var cls = getOwner(this).lookup('model:collection');
    console.log("=> [start] createCollection [" +key +"] claz=" + cls);

    var content = input[key].map(x => this._typeify(x, opt));
    var output = cls.constructor.create({ content: content });
    console.log("=> [info] createCollection [" +key +"] created content field in cls=" +cls + " constructor");

    Object.defineProperty(output, 'store', { value: this, configurable: true });
    console.log("=> [info] createCollection [" +key +"] input=" +input + ",metaKeys=" + Ember.getProperties(input, this.get('metaKeys')));
    output.setProperties(Ember.getProperties(input, this.get('metaKeys')));
    Ember.endPropertyChanges();
    return output;
  },

  getClassFor(type) {
    let cls = this._state.classCache[type];
    console.log("=> [start] getClassFor [" +type +"] cls=" +cls);
    if ( cls ) {
      return cls;
    }

    let owner = getOwner(this);
    if ( type ) {
      cls = owner.lookup('model:'+type);
      console.log("=> [info] getClassFor [" +type +"] type cls=" +cls);
    }

    if ( !cls ) {
      cls = owner.lookup('model:resource');
      console.log("=> [info] getClassFor [" +type +"] not type cls=" +cls);
    }

    this._state.classCache[type] = cls;
    console.log("=> [end] getClassFor [" +type +"] cls=" +cls);
    return cls;
  },

  // Create a record: {applyDefaults: false}
  createRecord(data, opt) {
    opt = opt || {};
    let type = normalizeType(Ember.get(opt,'type')||Ember.get(data,'type')||'');
    console.log("=> [start] createRecord [" +type +"]");

    let cls;
    if ( type ) {
      cls = this.getClassFor(type);
    }

    console.log("=> [info] createRecord [" +type +"] cls=" + cls);

    let schema = this.getById('schema',type);
    let input = data;

    console.log("=> [info] createRecord [" +type +"] schema=" + schema +",input=" + JSON.stringify(input));

    if ( opt.applyDefaults !== false && schema ) {
      input = schema.getCreateDefaults(data);
    }

    // actions is very unhappy property name for Ember...
    if ( this.replaceActions && typeof input.actions !== 'undefined')
    {
      input[this.replaceActions] = input.actions;
      delete input.actions;
    }

    let cons = cls.constructor;
    console.log("=> [info] createRecord [" +type +"] cons=" + cons);

    if ( cons.mangleIn && typeof cons.mangleIn === 'function' )
    {
      console.log("=> [info] createRecord [" +type +"] mangleIn="+cons.mangleIn);
      input = cons.mangleIn(input,this);
    }

    if ( schema ) {
      let fields = schema.get('typeifyFields');
      for ( let i = fields.length-1 ; i >= 0 ; i-- ) {
        let k = fields[i];
        if ( input[k] ) {
          input[k] = this._typeify(input[k], opt);
        }
      }
    }

    var output = cons.create(input);
    Object.defineProperty(output, 'store', { value: this, configurable: true});
    console.log("=> [end] createRecord [" +type +"] output="+ output);

    return output;
  },

  // Handle missing records in denormalized arrays
  // Get the cache map missing for [type]
  _missingMap(type) {
    type = normalizeType(type);
    let cache = this._state.missingMap;
    let group = cache[type];
    if ( !group )
    {
      group = {};
      cache[type] = group;
    }
    console.log("=> [end] _missingMap [" +type +"]");
    return group;
  },

  _missing(type, id, dependent, key) {
    type = normalizeType(type);
    let missingMap = this._missingMap(type);
    let entries = missingMap[id];
    if ( !entries ) {
      entries = [];
      missingMap[id] = entries;
    }

    console.log('=> [end] Missing [', type, "]", id, 'for', key, 'in', dependent);
    entries.push({o: dependent, k: key});
  },

  _notifyMissing(type,id) {
    let missingMap = this._missingMap(type);
    let entries = missingMap[id];
    console.log('=> [start] Notify missing [' + type + ']' +  id +  entries);
    if ( entries ) {
      entries.forEach((entry) => {
        console.log('=> [end] Recomputing [', type, ']',entry.k, 'for', type, id, 'in', entry.o);
        entry.o.notifyPropertyChange(entry.k);
      });

      entries.clear();
    }
  },
});

export default Store;
