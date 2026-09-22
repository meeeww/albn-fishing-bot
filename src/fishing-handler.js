const { FishingState } = require("./enums/FishingState");
const { FishingActions } = require("./fishing-actions");
const { FishBuffs } = require("./enums/FishBuffs")
const { getActionFromCoordinates: getAction } = require("./pixels");
const { sleep } = require("./utils");
const { Items } = require("./enums/Items");
const { ProcessQueue } = require("./process-queue");
const { checkIsIgnored } = require("./enums/IgnoredFishes");
const { AutoRestart } = require("./auto-restart");

class FishingHandler {
    isEnabled = false

    playerId = undefined
    fishingId = 0

    activeBuffs = undefined
    equipments = undefined

    loopInterval = 0
    pullPoint = [0, 0]
    restPoint = [0, 0]
    throwPoint = [0, 0]
    fishBaitCoor = [0, 0]
    windowInstance

    /** @type {ProcessQueue} */
    processQueue
    /** @type {AutoRestart} */
    autoRestart

    constructor(
        pullPoint,
        restPoint,
        throwPoint,
        fishBaitCoor,
        win,
    ) {
        this.pullPoint = pullPoint
        this.restPoint = restPoint
        this.throwPoint = throwPoint
        this.fishBaitCoor = fishBaitCoor
        this.windowInstance = win

        this.consumeBuff = this.consumeBuff.bind(this)
        this.equipBuff = this.equipBuff.bind(this)

        this.processQueue = new ProcessQueue()
        // Only used when a cast is stuck. A live line must not be clicked again.
        this.autoRestart = new AutoRestart(() => this.recover(), 60000)
        this.phase = 'idle'
        this.restarting = false
    }

    setEnabled(isEnabled) {
        this.isEnabled = isEnabled

        if (isEnabled) {
            // The cast that just hit the water is already out. Wait for the bite.
            this.phase = 'in-water'
            console.log('Waiting for a bite.')
            this.autoRestart.turnOn()
        } else {
            this.phase = 'idle'
            this.autoRestart.turnOff()
        }
    }

    updateThrowPoint(throwPoint) {
        this.throwPoint = throwPoint
    }

    updateFishingId(fishingId) {
        this.fishingId = fishingId
    }

    async updateState(parameters) {
        const fishingState = parameters[3];

        if (!fishingState) return;
        // Ignore fishingId mismatch to properly handle events, lock to playerId
        // if (parameters[1] != this.fishingId) return;

        if (this.playerId && parameters[0] !== this.playerId) return;
        if (!this.playerId) {
            this.playerId = parameters[0];
        }

        switch (fishingState) {
            case FishingState.THROW:
            case FishingState.TOUCH_WATER:
                this.phase = 'in-water'
                break;
            case FishingState.HOOKED:
            case FishingState.PULL:
            case FishingState.REST:
                this.phase = 'minigame'
                break;
            case FishingState.GET_AWAY:
            case FishingState.LOST:
            case FishingState.WIN:
            case FishingState.CANCEL:
                this.restart(this.playerId);
                break;
            default:
                break;
        }
        this.autoRestart.reboundTimeout()
    }

    async startPulling(playerId, parameters) {
        clearInterval(this.loopInterval)

        const isIgnored = checkIsIgnored(parameters)
        if (isIgnored) {
            await sleep(200)
            this.cancel()
            await this.restart(playerId)
            return;
        }

        this.phase = 'minigame'
        this.loopInterval = setInterval(() => {
            const action = getAction(this.pullPoint, this.restPoint)

            switch (action) {
                case 'pull':
                    return FishingActions.pull(this.throwPoint[0], this.throwPoint[1])
                case 'rest':
                    return FishingActions.rest(this.throwPoint[0], this.throwPoint[1])
                default:
                    break;
            }
        }, 20)
        this.autoRestart.reboundTimeout()
    }

    stopPulling(firedByUser = false) {
        clearInterval(this.loopInterval)
        if (firedByUser) return;
        FishingActions.rest(this.throwPoint[0], this.throwPoint[1])
    }

    async castOnce() {
        if (!this.isEnabled) return;
        if (this.phase === 'casting' || this.phase === 'in-water' || this.phase === 'minigame') return;

        this.phase = 'casting'
        this.windowInstance.setForeground();
        await FishingActions.throwBait(this.throwPoint[0], this.throwPoint[1])
        if (!this.isEnabled) return;
        this.phase = 'in-water'
        console.log('Waiting for a bite.')
        this.autoRestart.reboundTimeout()
    }

    async recover() {
        if (!this.isEnabled) return;
        if (this.phase === 'casting' || this.phase === 'minigame' || this.phase === 'cooldown') return;

        if (this.phase === 'in-water') {
            console.log('No bite. Cancelling the line, then recasting.')
            this.stopPulling()
            FishingActions.cancel()
            this.phase = 'cooldown'
            await sleep(2500)
            if (!this.isEnabled) return;
            this.phase = 'idle'
        }

        await this.castOnce()
    }

    restart = async (playerId) => {
        if (!this.isEnabled) return;
        if (this.playerId && playerId !== this.playerId) return;
        if (this.restarting) return;
        if (this.phase === 'cooldown' || this.phase === 'casting') return;

        this.restarting = true
        this.phase = 'cooldown'
        try {
            this.stopPulling()
            console.log('Round finished. Next cast in a moment.')
            await sleep(4000)
            if (!this.isEnabled) return;
            await this.processQueue.executeAllSequential()
            this.phase = 'idle'
            await this.castOnce()
        } finally {
            this.restarting = false
        }
    }

    cancel() {
        FishingActions.cancel()
    }

    async equipBuff(playerId, parameters) {
        if (playerId !== this.playerId) return;

        const equipments = parameters?.[2]
        const potSlot = equipments?.[8] ?? 0
        const foodSlot = equipments?.[9] ?? 0

        this.potSlotItemId = potSlot
        this.foodSlotItemId = foodSlot

        if (potSlot === 0) {
            this.cancel()
            await FishingActions.equipBait(this.fishBaitCoor)
        }

        if (foodSlot === 0) {
            // Todo: implement equip seaweed
        }
    }

    async consumeBuff(playerId, parameters) {
        if (playerId !== this.playerId) return;

        const activeBuffs = parameters?.[1] ?? []

        const baitBuffActive = [
            FishBuffs.FishBaitT1a,
            FishBuffs.FishBaitT1b,
            FishBuffs.FishBaitT3a,
            FishBuffs.FishBaitT3b,
            FishBuffs.FishBaitT5a,
            FishBuffs.FishBaitT5b,
        ].some((buffId) => {
            return activeBuffs.includes(buffId);
        });
        // const baitEquiped = [
        //     Items.T1_FISHINGBAIT,
        //     Items.T3_FISHINGBAIT,
        //     Items.T5_FISHINGBAIT,
        // ].includes(this.potSlotItemId)

        const seaweedBuffActive = activeBuffs.includes(FishBuffs.SeaweedSalad);
        // const seaweedEquiped = this.foodSlotItemId === Items.T1_MEAL_SEAWEEDSALAD;

        if (!baitBuffActive && this.phase !== 'in-water' && this.phase !== 'minigame' && this.phase !== 'casting') {
            this.stopPulling();
            FishingActions.consumeBait();
            await sleep(1000);
            this.restart(playerId)
        }

        if (!seaweedBuffActive) {
            // Todo: implement for seaweed salad
        }
    }

    addToQueue(handle, ...args) {
        this.processQueue.addProcess(handle, args)
    }
}

module.exports = {
    FishingHandler
}