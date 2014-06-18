/**
 * Constants
 */
const NODE_SERVICE = 'node'; // _node._tcp
const INCH_PORT = 32323;
const UDP_PORT = 42424;
const MACH_PORT = 45454;

/** 
 * Module dependencies
 */
var uuid = require('uuid');
var mdns = require('mdns');		// Zeroconf / mDNS / DNS-SD
var zmq = require('zmq');		// ZeroMQ
var dgram = require('dgram');	// for UDP sockets
var util = require('util'),		// extend the Core to be an EventEmitter
	EventEmitter = require('events').EventEmitter;

var Node = require('./node.js');// Node object

/**
 * Core object
 *
 * @name		hostname of the current computer
 * @uuid		unique identifier of the current core process
 * @nodes		array of Node objects 
 * @publisher	publisher socket (ZeroMQ) for information channel (InCh)
 * @udp			udp socket (unused)
 * @advertiser	mDNS advertiser of service _node._tcp
 * @browser		DNS-SD browser of _node._tcp services		
 * @mach		tcp socket for direct communication between node's core (MaCh)
 */
function Core()
{
	this.name = require('os').hostname();
	this.uuid = uuid.v1();
	this.nodes = [];
	this.ip = null;
	this.sensors = [];
	this.resources = [];
	this.publisher = zmq.socket('pub');	// publisher socket (inch)
	this.subscriber = zmq.socket('sub');
	this.udp = dgram.createSocket('udp4');	// local channel
	this.requester = zmq.socket('dealer');
	this.mach = zmq.socket('router');
	this.syncRequester = zmq.socket('req');
	// advertisement of a _node._tcp. service on this node, on port 32323
	this.advertiser = createAdvertisement(this.uuid);
	// _node._tcp. service browser
	this.browser = mdns.createBrowser(mdns.tcp(NODE_SERVICE));
}
// Inherit from `EventEmitter.prototype`.
util.inherits(Core, EventEmitter);

// Expose the Core singleton 
// Provide self for convenience within module
var self = module.exports = new Core();

/**
 * Initiliaze the Core singleton
 * Binding sockets, advertising and browsing for other _node._tcp cores
 * Emit 'ready' event when initialized
 */
Core.prototype.init = function() {
	console.log('+[CORE]\tCore starting on '+this.name);
	// bind local socket
	this.udp.bind(UDP_PORT, function() {
		var address = self.udp.address();
		console.log('+[UDP]\tUDP socket listening on '+address.address+':'+address.port);
	});
	// bind publish socket and start advertising and browsing
	this.publisher.bind('tcp://*:'+INCH_PORT, function(err) {
		if (err) {
			console.log('![PUB]\tPublisher binding error: '+err);
		}
		else {
			console.log('+[PUB]\tPublisher socket listening on '+INCH_PORT);
			self.advertise();
			self.browse();
		}
	});
	// bind mach channel
	this.mach.bind('tcp://*:'+MACH_PORT, function(err) {
		if (err)
			console.log('![MACH]\tSocket binding error: '+err);
		else
			console.log('+[MACH]\tSocket listening on '+MACH_PORT);
	});
	// subscribe socket
	this.emit('ready');
};

/**
 * Start mDNS advertisement of _node._tcp service
 */
Core.prototype.advertise = function() {
	this.advertiser.start();
	console.log('+[CORE]\tAdvertising _'+NODE_SERVICE+'._tcp on '+INCH_PORT);
};

/**
 * Start discovery of _node._tcp services
 */
Core.prototype.browse = function() {
	this.browser.start();
	console.log('+[mDNS]\tStart browsing for _'+NODE_SERVICE+'._tcp services');
};

/**
 * Handle the reception of messages on the subscriber socket (inch)
 * Emits 'inch' event on core
 * 
 * @param  {blob} data [blob of data (JSON)]
 */
self.subscriber.on('message', function(data) {
	var msg = JSON.parse(data);
	self.emit('inch', msg.header, msg.payload);
});

/**
 * Wrappers arount socket reception of message
 * Emits 'mach' event on core
 * 
 * @param  {blob} data [blob of data (JSON)]
 */

self.mach.on('message', function() {
	console.log(':[DBUG]\tRouter: '+arguments.length);
	for (k in arguments)
		console.log(arguments[k].toString());
	switch (arguments.length) {
		case 2:
			var envelope = arguments[0];
			var msg = JSON.parse(arguments[1]);
			break;
		case 3:
			var envelope = arguments[0];
			var msg = JSON.parse(arguments[2]);
			break;
		default:
			return;
	}

	self.emit('mach', envelope, msg.header, msg.payload);
});

self.requester.on('message', function(data) {
	console.log(':[DBUG]\tDealer: '+arguments.length);
	for (k in arguments)
		console.log(arguments[k].toString());
	switch (arguments.length) {
		case 2:
			var data = JSON.parse(arguments[1]);
			break;
		case 3:
			var data = JSON.parse(arguments[2]);
			break;
		default:
			return;
	}
	self.emit('reply', data.header, data.payload);
});

/**
 * Display errors with sockets
 */
self.subscriber.on('error', function(err) {
	console.log('![SUB]\tSocket error: '+err);
});

self.mach.on('error', function(err) {
	console.log('![REP]\tSocket error: '+err);
});

self.requester.on('error', function(err) {
	console.log('![REQ]\tSocket error: '+err);
});

self.publisher.on('error', function(err) {
	console.log('![PUB]\tSocket error: '+err);
});

self.udp.on('message', function(buffer, rinfo) {
	console.log('>[UDP]\tfrom '+rinfo);
	console.log(buffer.toString());
});

/**
 * Handle the discovery of new _node._tcp service
 * (mDNS browser event)
 */
self.browser.on('serviceUp', function(service) {
	console.log('+[mDNS]\tService up: '+service.name+' at '+service.addresses+' ('+service.networkInterface+')');

	if(!self.findNodeById(service.txtRecord.id))
	{
		var new_node = new Node(service);
		if (self.uuid != service.txtRecord.id) {
			self.newSubscribe(new_node.ip);
		}
		else {
			// note if itself
			new_node.itself = 'true';
			// register advertising ip, we should see ourself
			self.ip = new_node.ip;
		}
		self.nodes.push(new_node);
		console.log('+[CORE]\tAdding node id '+service.txtRecord.id);
	}
	else {
		console.log('![CORE]\tNode id '+service.txtRecord.id+' is already present');
	}
});

/**
 * Subscribe to new discovered node
 * 
 * @param  {String} peer [IP address of the new discovered node]
 */
Core.prototype.newSubscribe = function(peer) {
	this.subscriber.connect('tcp://'+peer+':'+INCH_PORT);
	this.subscriber.subscribe('');
	console.log('+[SUB]\tSubscribing to '+peer);
};

/**
 * Delete dead node from local node list when 'serviceDown'
 */
self.browser.on('serviceDown', function(service) {
	console.log('-[mDNS]\tService down: '+service.name+' ('+service.networkInterface+')');
	self.deleteDeadNode(service.name);
});

/**
 * Handle mDNS browser errors
 */
self.browser.on('error', function(error) {
	console.log('![mDNS]\tBrowser error: '+error);
});

/**
 * Get the name of the Core
 */
Core.prototype.toString = function() {
	return this.name;
};

/**
 * Stopping mDNS advertising/browsing,
 * closing sockets and exiting
 */
Core.prototype.close = function(exit) {
	console.log('[CORE]\tClosing');
	this.browser.stop();
	this.advertiser.stop();
	this.publisher.close();
	this.subscriber.close();
	this.requester.close();
	this.udp.close();
	if (typeof exit === "undefined")
		process.exit();
};

/**
 * [publish description]
 * @param  {[type]} data [description]
 */
Core.prototype.publish = function(cmd, data) {
	this.publisher.send(JSON.stringify(this.createMessage(cmd, data)));
};

/**
 * Create an object representing the structure of message
 * used between cores
 * always adding name and uuid
 * 
 * @param  {String} cmd  [type of the message]
 * @param  {?}		data [payload of the message]
 * @return {Object}      [message sent on the socket]
 */
Core.prototype.createMessage = function(cmd, data) {
	var h = {src: this.uuid, name: this.name, ip: this.ip, type: cmd};
	return {header: h, payload: data};
};

/**
 * [send description]
 * @param  {[type]} dst  [description]
 * @param  {[type]} cmd  [description]
 * @param  {[type]} data [description]
 * @return {[type]}      [description]
 */
Core.prototype.send = function(dst, cmd, data) {
	if (dst != null) {
		this.requester.connect('tcp://'+dst+':'+MACH_PORT);
		this.requester.send([null, JSON.stringify(this.createMessage(cmd, data))]);
	}
	else {
		throw 'send() to null IP';
	}	
};

Core.prototype.syncSend = function(dst, cmd, data, callback) {
	var socket = zmq.socket('req');
	if (dst != null) {
		socket.connect('tcp://'+dst+':'+MACH_PORT);
		socket.send(JSON.stringify(this.createMessage(cmd, data)));
		console.log('+[SYNC]\tSending '+data+' to '+dst);

		socket.on('message', function(data) {
			console.log('>[SYNC]\tReceived '+data.toString());
			var msg = JSON.parse(data);
			callback(msg.header, msg.payload);
			socket.close();
		});
	}
	else {
		throw 'send() to null IP';
	}
};

Core.prototype.reply = function(cmd, envelope, data) {
	var msg = this.createMessage(cmd, data);
	this.mach.send([envelope, '', JSON.stringify(msg)]);
};

/**
 * Delete node when service down
 * @param  {Node[]}	nodes      list of Node objects
 * @param  {String} node_name  node canonical name to be deleted
 */
Core.prototype.deleteDeadNode = function(node_name){
	var index = null;
	for(k in this.nodes){
		if (this.nodes[k].name == node_name)  index = k;
	}
	if(index != null) {
		if (node_name != this.name && this.nodes[index].ip != this.ip) {
			this.subscriber.disconnect('tcp://'+this.nodes[index].ip+':'+INCH_PORT);
		}
		this.nodes.splice(index,1);
		console.log('-[CORE]\tDeleting node '+node_name);
	}
	else {
		console.log('![CORE]\tError cannot delete node '+node_name+', not found ; no harm, maybe just a duplicate serviceDown');
	}
};

/**
 * Check if a particular node is present within a list of node
 * Using UUID to disambiguate nodes
 * 
 * @param  {String} uuid  [uuid of the sought node]
 * @return {Boolean}      [return true if found}
 */
Core.prototype.findNodeById = function (uuid){
	for(k in this.nodes){
		if (this.nodes[k].id == uuid)  
			return true;
	}
	return false;
};

Core.prototype.getNodeById = function(uuid){
	for(idx in this.nodes){
		if (this.nodes[idx].id == uuid)
			return this.nodes[idx];
	}
	return null;
};

Core.prototype.getNodeIpById = function(uuid){
	for(idx in this.nodes){
		if (this.nodes[idx].id == uuid)
			return this.nodes[idx].ip;
	}
	return null;
};

/**
 * Wrapper for creating mDNS advertiser
 * Using DNS TXT records to publish additional information of the node 
 * 
 * @param  {String} uuid identifier of the node
 * @return {mdns.Advertisement}
 */
function createAdvertisement(uuid)  {
    var mdns_txt_record = {
        id: uuid
    };
    
    var advertiser = mdns.createAdvertisement(mdns.tcp(NODE_SERVICE), INCH_PORT, {txtRecord: mdns_txt_record});
    advertiser.on('error', function(error) {
        console.log("![CORE]\t", error);
        setTimeout(createAdvertisement, 30 * 1000);
    });
    return advertiser;
}


/******* protocol *********/

/******* message *********/
Core.prototype.payloadRequest = function (res, port) {
	var _p = port || UDP_PORT;
	return {data: res, port: _p};
};

Core.prototype.payloadAck = function (s) {
	return {status: s};
};
