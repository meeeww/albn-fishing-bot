const PhotonPacket = require('./PhotonPacket');
const EventEmitter = require('events');

class PhotonPacketParser extends EventEmitter {
	constructor() {
		super();
	}

	handle(buff) {
		try {
			this.emit('packet', new PhotonPacket(this, buff));
		} catch {
			return
		}
	}
}

module.exports = PhotonPacketParser;