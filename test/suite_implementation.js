import {PNG} from 'pngjs';
import Map from '../src/ui/map';
import config from '../src/util/config';
import window from '../src/util/window';
import browser from '../src/util/browser';
import {plugin as rtlTextPlugin} from '../src/source/rtl_text_plugin';
import rtlText from '@mapbox/mapbox-gl-rtl-text';
import fs from 'fs';
import path from 'path';
import customLayerImplementations from './integration/custom_layer_implementations';

rtlTextPlugin['applyArabicShaping'] = rtlText.applyArabicShaping;
rtlTextPlugin['processBidirectionalText'] = rtlText.processBidirectionalText;
rtlTextPlugin['processStyledBidirectionalText'] = rtlText.processStyledBidirectionalText;

module.exports = function(style, options, _callback) { // eslint-disable-line import/no-commonjs
    let wasCallbackCalled = false;

    const timeout = setTimeout(() => {
        callback(new Error('Test timed out'));
    }, options.timeout || 20000);

    function callback(...args) {
        if (!wasCallbackCalled) {
            clearTimeout(timeout);
            wasCallbackCalled = true;
            _callback(...args);
        }
    }

    window.devicePixelRatio = options.pixelRatio;

    if (options.addFakeCanvas) {
        const fakeCanvas = createFakeCanvas(window.document, options.addFakeCanvas.id, options.addFakeCanvas.image);
        window.document.body.appendChild(fakeCanvas);
    }

    const container = window.document.createElement('div');
    Object.defineProperty(container, 'clientWidth', {value: options.width});
    Object.defineProperty(container, 'clientHeight', {value: options.height});

    // We are self-hosting test files.
    config.REQUIRE_ACCESS_TOKEN = false;

    const map = new Map({
        container,
        style,
        classes: options.classes,
        interactive: false,
        attributionControl: false,
        preserveDrawingBuffer: true,
        axonometric: options.axonometric || false,
        skew: options.skew || [0, 0],
        fadeDuration: options.fadeDuration || 0,
        localIdeographFontFamily: options.localIdeographFontFamily || false,
        crossSourceCollisions: typeof options.crossSourceCollisions === "undefined" ? true : options.crossSourceCollisions
    });

    // Configure the map to never stop the render loop
    map.repaint = true;

    let now = 0;
    browser.now = function() {
        return now;
    };

    if (options.debug) map.showTileBoundaries = true;
    if (options.showOverdrawInspector) map.showOverdrawInspector = true;
    if (options.showPadding) map.showPadding = true;

    const gl = map.painter.context.gl;

    map.once('load', () => {
        if (options.collisionDebug) {
            map.showCollisionBoxes = true;
            if (options.operations) {
                options.operations.push(["wait"]);
            } else {
                options.operations = [["wait"]];
            }
        }
        applyOperations(map, options.operations, () => {
            const viewport = gl.getParameter(gl.VIEWPORT);
            const w = viewport[2];
            const h = viewport[3];

            const pixels = new Uint8Array(w * h * 4);
            gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

            const data = new Buffer(pixels);

            // Flip the scanlines.
            const stride = w * 4;
            const tmp = new Buffer(stride);
            for (let i = 0, j = h - 1; i < j; i++, j--) {
                const start = i * stride;
                const end = j * stride;
                data.copy(tmp, 0, start, start + stride);
                data.copy(data, start, end, end + stride);
                tmp.copy(data, end);
            }

            const results = options.queryGeometry ?
                map.queryRenderedFeatures(options.queryGeometry, options.queryOptions || {}) :
                [];

            map.remove();
            gl.getExtension('STACKGL_destroy_context').destroy();
            delete map.painter.context.gl;

            if (options.addFakeCanvas) {
                const fakeCanvas = window.document.getElementById(options.addFakeCanvas.id);
                fakeCanvas.parentNode.removeChild(fakeCanvas);
            }

            callback(null, data, results.map((feature) => {
                feature = feature.toJSON();
                delete feature.layer;
                return feature;
            }));

        });
    });

    function applyOperations(map, operations, callback) {
        const operation = operations && operations[0];
        if (!operations || operations.length === 0) {
            callback();

        } else if (operation[0] === 'wait') {
            if (operation.length > 1) {
                now += operation[1];
                map._render();
                applyOperations(map, operations.slice(1), callback);

            } else {
                const wait = function() {
                    if (map.loaded()) {
                        applyOperations(map, operations.slice(1), callback);
                    } else {
                        map.once('render', wait);
                    }
                };
                wait();
            }

        } else if (operation[0] === 'sleep') {
            // Prefer "wait", which renders until the map is loaded
            // Use "sleep" when you need to test something that sidesteps the "loaded" logic
            setTimeout(() => {
                applyOperations(map, operations.slice(1), callback);
            }, operation[1]);
        } else if (operation[0] === 'addImage') {
            const {data, width, height} = PNG.sync.read(fs.readFileSync(path.join(__dirname, './integration', operation[2])));
            map.addImage(operation[1], {width, height, data: new Uint8Array(data)}, operation[3] || {});
            applyOperations(map, operations.slice(1), callback);
        } else if (operation[0] === 'addCustomLayer') {
            map.addLayer(new customLayerImplementations[operation[1]](), operation[2]);
            map._render();
            applyOperations(map, operations.slice(1), callback);
        } else if (operation[0] === 'updateFakeCanvas') {
            const canvasSource = map.getSource(operation[1]);
            canvasSource.play();
            // update before pause should be rendered
            updateFakeCanvas(window.document, options.addFakeCanvas.id, operation[2]);
            canvasSource.pause();
            // update after pause should not be rendered
            updateFakeCanvas(window.document, options.addFakeCanvas.id, operation[3]);
            map._render();
            applyOperations(map, operations.slice(1), callback);
        } else if (operation[0] === 'setStyle') {
            // Disable local ideograph generation (enabled by default) for
            // consistent local ideograph rendering using fixtures in all runs of the test suite.
            map.setStyle(operation[1], {localIdeographFontFamily: false});
            applyOperations(map, operations.slice(1), callback);
        } else if (operation[0] === 'pauseSource') {
            map.style.sourceCaches[operation[1]].pause();
            applyOperations(map, operations.slice(1), callback);
        } else {
            if (typeof map[operation[0]] === 'function') {
                map[operation[0]](...operation.slice(1));
            }
            applyOperations(map, operations.slice(1), callback);
        }
    }
};

function createFakeCanvas(document, id, imagePath) {
    const fakeCanvas = document.createElement('canvas');
    const image = PNG.sync.read(fs.readFileSync(path.join(__dirname, './integration', imagePath)));
    fakeCanvas.id = id;
    fakeCanvas.data = image.data;
    fakeCanvas.width = image.width;
    fakeCanvas.height = image.height;
    return fakeCanvas;
}

function updateFakeCanvas(document, id, imagePath) {
    const fakeCanvas = document.getElementById(id);
    const image = PNG.sync.read(fs.readFileSync(path.join(__dirname, './integration', imagePath)));
    fakeCanvas.data = image.data;
}
