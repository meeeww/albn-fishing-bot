const { FishingState } = require("./enums/FishingState");
const { FishingActions } = require("./fishing-actions");
const { FishBuffs } = require("./enums/FishBuffs")
const { getReelAction } = require("./pixels");
const { sleep } = require("./utils");
const { Items } = require("./enums/Items");
const { ProcessQueue } = require("./process-queue");
const { checkIsIgnored } = require("./enums/IgnoredFishes");
const { AutoRestart } = require("./auto-restart");

const STATE_LABEL = {
    [FishingState.WIN]: 'caught',
    [FishingState.LOST]: 'lost',
    [FishingState.GET_AWAY]: 'got away',
    [FishingState.CANCEL]: 'cancelled',
}

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
        this.sessionId = undefined
        this.reeling = false
    }

    setEnabled(isEnabled) {
        this.isEnabled = isEnabled

        if (isEnabled) {
            // The cast that just hit the water is already out. Wait for the bite.
            this.phase = 'in-water'
            this.sessionId = undefined
            this.reeling = false
            this.landedAt = Date.now()
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

        const sessionId = parameters[0]
        if (this.sessionId && sessionId !== this.sessionId) return
        if (!this.sessionId) this.sessionId = sessionId

        switch (fishingState) {
            case FishingState.THROW:
            case FishingState.TOUCH_WATER:
                this.lineConfirmed = true
                this.phase = 'in-water'
                break;
            case FishingState.HOOKED:
                if (!this.reeling) {
                    console.log('Bite. Reeling.')
                    this.onNote?.('Bite. Reeling.')
                    await this.startPulling(sessionId, parameters)
                }
                break;
            case FishingState.PULL:
            case FishingState.REST:
                this.phase = 'minigame'
                break;
            case FishingState.GET_AWAY:
            case FishingState.LOST:
            case FishingState.WIN:
            case FishingState.CANCEL:
                this.reeling = false
                this.restart(this.playerId, STATE_LABEL[fishingState] || `state ${fishingState}`);
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
            await this.restart(playerId, 'ignored fish')
            return;
        }

        this.reelToken = (this.reelToken || 0) + 1
        const token = this.reelToken
        this.phase = 'minigame'
        this.reeling = true
        this.sawBar = false
        this.reelError = false
        this.windowInstance.setForeground()
        FishingActions.hook(this.throwPoint[0], this.throwPoint[1])

        let missedScans = 0
        let clicks = 1

        this.loopInterval = setInterval(() => {
            if (this.reelToken !== token) return
            try {
                const seen = getReelAction()
                if (!seen?.bar) {
                    missedScans += 1
                    if (missedScans % 12 === 0 && clicks < 4) {
                        clicks += 1
                        console.log('Reel bar is not open. Clicking again.')
                        this.windowInstance.setForeground()
                        FishingActions.hook(this.throwPoint[0], this.throwPoint[1])
                    }
                    return
                }
                if (!this.sawBar) {
                    this.sawBar = true
                    console.log('Green zone is on screen.')
                }
                if (!seen.action) return

                switch (seen.action) {
                    case 'pull':
                        return FishingActions.pull(this.throwPoint[0], this.throwPoint[1])
                    case 'rest':
                        return FishingActions.rest(this.throwPoint[0], this.throwPoint[1])
                    default:
                        break;
                }
            } catch (error) {
                if (this.reelError) return
                this.reelError = true
                console.log('Reel scan failed:', error.message)
            }
        }, 50)
        this.autoRestart.reboundTimeout()
    }

    stopPulling(firedByUser = false) {
        clearInterval(this.loopInterval)
        this.reelToken = (this.reelToken || 0) + 1
        this.reeling = false
        if (firedByUser) return;
        FishingActions.rest(this.throwPoint[0], this.throwPoint[1])
    }

    async castOnce(attempt = 0) {
        if (!this.isEnabled) return;
        if (attempt === 0 && (this.phase === 'casting' || this.phase === 'in-water' || this.phase === 'minigame')) return;
        if (attempt > 2) {
            console.log('Could not get a line in the water.')
            this.phase = 'idle'
            return
        }

        this.phase = 'casting'
        this.lineConfirmed = false
        this.sessionId = undefined
        this.reeling = false
        this.windowInstance.setForeground();
        await FishingActions.throwBait(this.throwPoint[0], this.throwPoint[1])
        if (!this.isEnabled) return;

        const started = Date.now()
        while (!this.lineConfirmed && Date.now() - started < 4000) {
            await sleep(200)
            if (!this.isEnabled) return
        }

        if (!this.lineConfirmed) {
            console.log('Cast did not land. Retrieving the hook, then trying again.')
            this.windowInstance.setForeground()
            FishingActions.retrieve(this.throwPoint[0], this.throwPoint[1])
            await sleep(1500)
            if (!this.isEnabled) return
            this.phase = 'idle'
            await this.castOnce(attempt + 1)
            return
        }

        this.phase = 'in-water'
        this.landedAt = Date.now()
        console.log('Waiting for a bite.')
        this.autoRestart.reboundTimeout()
    }

    async recover() {
        if (!this.isEnabled) return;
        if (this.phase === 'casting' || this.phase === 'minigame' || this.phase === 'cooldown') return;

        if (this.phase === 'in-water') {
            console.log('No bite. Cancelling the line, then retrieving the hook.')
            this.stopPulling()
            FishingActions.cancel()
            await sleep(600)
            this.windowInstance.setForeground()
            FishingActions.retrieve(this.throwPoint[0], this.throwPoint[1])
            this.phase = 'cooldown'
            await sleep(2000)
            if (!this.isEnabled) return;
            this.phase = 'idle'
        }

        await this.castOnce()
    }

    restart = async (playerId, reason = 'unspecified') => {
        if (!this.isEnabled) return;
        if (this.playerId && playerId !== this.playerId) return;
        if (this.restarting) return;
        if (this.phase === 'cooldown' || this.phase === 'casting') return;

        const age = Date.now() - (this.landedAt || 0)
        if (this.phase === 'in-water' && age < 3000) {
            const text = `Ignored an early finish ${age}ms after the cast (${reason}). Still waiting for a bite.`
            console.log(text)
            this.onNote?.(text)
            return
        }

        this.restarting = true
        this.phase = 'cooldown'
        try {
            this.stopPulling()
            const text = `Round finished (${reason}). Retrieving the hook.`
            console.log(text)
            this.onNote?.(text)
            this.windowInstance.setForeground()
            FishingActions.retrieve(this.throwPoint[0], this.throwPoint[1])
            await sleep(2000)
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
            this.restart(playerId, 'bait buff missing')
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