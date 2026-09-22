const FishingEvents = {
    ActiveSpellEffectsUpdate: 10,
    CharacterEquipmentChanged: 87,
    // 355 carries parameters[3]: throw, touch water, hooked, pull, rest, win.
    FishingState: 355,
    FloatUpdate: 360,
    MiniGame: 361,
}

module.exports = {
    FishingEvents
}
