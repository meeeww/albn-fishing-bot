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

const whole = (value) => {
    const rounded = Math.round(value)
    return Number.isFinite(rounded) ? rounded : null
}

const readPixel = (img, x, y) => {
    const offset = (y * img.byteWidth) + (x * img.bytesPerPixel)
    const blue = img.image[offset]
    const green = img.image[offset + 1]
    const red = img.image[offset + 2]
    return [red, green, blue]
}

const isGreen = (red, green, blue) => green >= 170 && green >= red + 50 && green >= blue + 40

const isMarker = (red, green, blue) => {
    if (isGreen(red, green, blue)) return false
    return red >= 190 && green >= 170 && blue >= 130 && Math.abs(red - green) < 70
}

// Hold moves the bobber right. Release lets it drift left.
// Keep the bright marker inside the green zone on the reel bar.
const getReelAction = (region) => {
    const x = whole(region.x)
    const y = whole(region.y)
    const width = whole(region.width)
    const height = whole(region.height)
    if (x === null || y === null || !width || !height) return

    const img = robot.screen.capture(x, y, width, height)
    if (!img?.image) return

    let best = null
    for (let row = 0; row < height; row += 2) {
        let run = 0
        let runStart = 0
        let longest = 0
        let longestStart = 0
        for (let col = 0; col < width; col += 2) {
            const [red, green, blue] = readPixel(img, col, row)
            if (isGreen(red, green, blue)) {
                if (run === 0) runStart = col
                run += 2
            } else if (run > longest) {
                longest = run
                longestStart = runStart
                run = 0
            } else {
                run = 0
            }
        }
        if (run > longest) {
            longest = run
            longestStart = runStart
        }
        if (longest >= 24 && (!best || longest > best.length)) {
            best = { row, start: longestStart, length: longest }
        }
    }

    if (!best) return { bar: false }

    const markerXs = []
    const top = Math.max(0, best.row - 10)
    const bottom = Math.min(height - 1, best.row + 10)
    for (let row = top; row <= bottom; row++) {
        for (let col = 0; col < width; col++) {
            const [red, green, blue] = readPixel(img, col, row)
            if (isMarker(red, green, blue)) markerXs.push(col)
        }
    }
    if (markerXs.length < 2) return { bar: true, action: null }

    markerXs.sort((a, b) => a - b)
    const markerX = markerXs[Math.floor(markerXs.length / 2)]
    const zoneCenter = best.start + (best.length / 2)
    const slack = Math.max(6, best.length * 0.2)

    if (markerX < zoneCenter - slack) return { bar: true, action: 'pull' }
    if (markerX > zoneCenter + slack) return { bar: true, action: 'rest' }
    return { bar: true, action: null }
}

const getActionFromCoordinates = (pullPoint, restPoint) => {
    const leftX = whole(Math.min(pullPoint[0], restPoint[0]));
    const rightX = whole(Math.max(pullPoint[0], restPoint[0]));
    const y = whole(pullPoint[1]);
    if (leftX === null || rightX === null || y === null) return;

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
    getReelAction,
}