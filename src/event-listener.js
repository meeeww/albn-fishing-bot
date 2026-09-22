const PhotonParser = require('../vendor/photon-packet-parser');
const { deviceForIp, startCapture } = require('./capture')
const { networkInterfaces } = require('os')
const readlineSync = require('readline-sync');

const FILTER = 'udp and (dst port 5056 or src port 5056)';

const initListener = () => {
    const listener = new PhotonParser();
    const adapterIp = getAdapterIp()
    const device = deviceForIp(adapterIp)

    if (!device) {
        console.log(`No capture device found for ${adapterIp}. Install Npcap, then run this again.`)
        process.exit(1)
    }

    startCapture(device.name, FILTER, (payload) => {
        listener.handle(payload)
    })

    return listener
}

const getAdapterIp = () => {
    const interfaces = networkInterfaces()

    console.log()
    console.log('Please select one of the adapter that you use to connect to the internet:')

    let i = 1;
    const selection = {}
    const selectionName = {}
    for (const [name, value] of Object.entries(interfaces)) {
        const detail = value.find(v => v.family === 'IPv4')
        if (!detail) continue;
        selection[i] = detail.address;
        selectionName[i] = name;
        console.log(`  ${i}. ${name}\t ip address: ${detail.address}`)
        i++;
    }

    console.log()
    let userSelect = readlineSync.question('input the number here: ');
    const selectedIp = selection[userSelect]
    const selectedName = selectionName[userSelect]

    if (!selectedIp) {
        console.log()
        console.log('invalid input, try again')
        return getAdapterIp()
    }

    console.log()
    console.log(`you have selected "${selectedName}"`)
    console.log()

    return selectedIp
}

module.exports = {
    initListener,
}