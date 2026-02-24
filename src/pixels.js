const robot = require('robotjs')
const ColorClassifier = require("color-classifier");

const colorClassifier = new ColorClassifier([
    '#ffffff',
    '#ff0000',
    '#00ff00',
    '#0000ff',
]);

const getPixelColorAt = (x, y) => {
    var hex = robot.getPixelColor(x, y);
    const classified = colorClassifier.classify("#" + hex, 'hex')
    return classified;
}

const getActionFromCoordinates = (pullPoint, restPoint) => {
    const leftX = Math.min(pullPoint[0], restPoint[0]);
    const rightX = Math.max(pullPoint[0], restPoint[0]);
    const y = pullPoint[1];
    const width = rightX - leftX;

    if (width <= 0) return;

    // Dynamically scan the entire bar between pullPoint and restPoint natively
    const img = robot.screen.capture(leftX, y, width + 1, 1);

    let startX = -1;
    let endX = -1;

    for (let i = 0; i <= width; i++) {
        const hex = img.colorAt(i, 0);
        const classified = colorClassifier.classify("#" + hex, 'hex');
        if (classified !== '#00ff00') {
            if (startX === -1) startX = leftX + i;
            endX = leftX + i;
        } else if (startX !== -1) {
            // Bobber found and passed, stop scanning
            break;
        }
    }

    if (startX === -1) {
        // Bobber not found
        return;
    }

    // Exact location of the bobber
    const bobberX = startX + (endX - startX) / 2;

    // Calculate middle point of the bar
    const midX = leftX + width / 2;

    // Introduce a deadzone in the very center of the bar (middle 4%)
    const deadzoneRadius = width * 0.05; // 5% each side
    const deadzoneLeft = midX - deadzoneRadius;
    const deadzoneRight = midX + deadzoneRadius;

    // Actively pull or rest to keep bobber ping-ponging tightly inside center deadzone
    if (bobberX < deadzoneLeft) {
        return 'pull';
    } else if (bobberX > deadzoneRight) {
        return 'rest';
    }

    // Return undefined inside deadzone to continue previous action (ping-pong effect)
    return undefined;
}

module.exports = {
    getPixelColorAt,
    getActionFromCoordinates,
}