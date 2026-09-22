const robot = require('robotjs');
const { sleep } = require('./utils');

// Long enough for the bobber to leave the rod. A tap (50ms) never reaches the water.
const CAST_HOLD_MS = 800
let isPulling = false

class FishingActions {
    static async throwBait(x, y) {
        console.log('action: throwBait')
        if (isPulling) {
            robot.mouseToggle("up")
            isPulling = false
        }
        robot.moveMouse(x, y);
        robot.mouseToggle("down");
        await sleep(CAST_HOLD_MS)
        robot.mouseToggle("up")
    }

    static async hook(x, y) {
        console.log('action: hook')
        if (isPulling) {
            robot.mouseToggle("up")
            isPulling = false
        }
        robot.moveMouse(Math.round(x), Math.round(y))
        robot.mouseToggle("down")
        await sleep(80)
        robot.mouseToggle("up")
    }

    static pull(x, y) {
        if (!isPulling) {
            console.log('action: pull')
            robot.moveMouse(Math.round(x), Math.round(y));
            robot.mouseToggle("down");
            isPulling = true;
        }
    }

    static rest(x, y) {
        if (isPulling) {
            console.log('action: rest')
            robot.moveMouse(Math.round(x), Math.round(y));
            robot.mouseToggle("up");
            isPulling = false;
        }
    }

    static cancel() {
        console.log('action: cancel');
        robot.keyTap('escape');
    }

    static async equipBait(baitCoor) {
        console.log('action: equip bait');
        robot.keyTap('escape');
        robot.keyTap('i');
        await sleep(500)
        robot.moveMouse(baitCoor[0], baitCoor[1]);
        robot.mouseClick('right');
        await sleep(100)
        robot.keyTap('escape')
    }

    static consumeBait() {
        console.log('action: consume bait');
        robot.keyTap('1');
    }
}

module.exports = {
    FishingActions
}