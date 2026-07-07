// Tests unitarios para Pieces - Gestión de piezas
// Ejecutar con: node tests/pieces.test.js

const assert = require('assert');

// Simular entorno de navegador
global.window = global;
global.console = console;
global.document = {
    getElementById: (id) => null,
    createElement: () => ({ style: {} }),
    body: { appendChild: () => {} },
    addEventListener: () => {}
};

// Cargar dependencias
require('../public/app/state/store.js');
require('../public/app/features/pieces.js');

const Store = global.Store;

// ============================================
// TESTS
// ============================================

let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        fn();
        console.log(`✅ ${name}`);
        passed++;
    } catch (e) {
        console.error(`❌ ${name}`);
        console.error(`   ${e.message}`);
        failed++;
    }
}

// Test: validatePieceInput existe
test('validatePieceInput existe', () => {
    assert.ok(typeof global.validatePieceInput === 'function', 'validatePieceInput debe existir');
});

test('validatePieceInput valida partNumber vacío', () => {
    const errors = global.validatePieceInput('', 10, 0);
    assert.ok(errors.length > 0, 'Debe retornar errores para partNumber vacío');
    assert.ok(errors.some(e => e.includes('número de parte')), 'Debe mencionar número de parte');
});

test('validatePieceInput valida partNumber null', () => {
    const errors = global.validatePieceInput(null, 10, 0);
    assert.ok(errors.length > 0, 'Debe retornar errores para partNumber null');
});

test('validatePieceInput acepta partNumber válido', () => {
    const errors = global.validatePieceInput('ABC-123', 10, 0);
    assert.strictEqual(errors.length, 0, 'No debe haber errores para entrada válida');
});

test('validatePieceInput valida quantity no numérica', () => {
    const errors = global.validatePieceInput('ABC-123', 'abc', 0);
    assert.ok(errors.length > 0, 'Debe retornar errores para quantity no numérica');
});

test('validatePieceInput valida quantity negativa', () => {
    const errors = global.validatePieceInput('ABC-123', -5, 0);
    assert.ok(errors.length > 0, 'Debe retornar errores para quantity negativa');
    assert.ok(errors.some(e => e.includes('negativa')), 'Debe mencionar negativa');
});

test('validatePieceInput acepta quantity cero', () => {
    const errors = global.validatePieceInput('ABC-123', 0, 0);
    assert.strictEqual(errors.length, 0, 'No debe haber errores para quantity cero');
});

test('validatePieceInput valida incidents negativos', () => {
    const errors = global.validatePieceInput('ABC-123', 10, -1);
    assert.ok(errors.length > 0, 'Debe retornar errores para incidents negativos');
});

test('validatePieceInput acepta incidents vacíos', () => {
    const errors = global.validatePieceInput('ABC-123', 10, '');
    assert.strictEqual(errors.length, 0, 'No debe haber errores para incidents vacíos');
});

test('validatePieceInput acepta incidents undefined', () => {
    const errors = global.validatePieceInput('ABC-123', 10, undefined);
    assert.strictEqual(errors.length, 0, 'No debe haber errores para incidents undefined');
});

// Test: recalculateMetricsForLot existe
test('recalculateMetricsForLot existe', () => {
    assert.ok(typeof global.recalculateMetricsForLot === 'function', 'recalculateMetricsForLot debe existir');
});

test('recalculateMetricsForLot calcula métricas laser', () => {
    Store.setLocalData({
        'laser-test': {
            name: 'Test Laser',
            pieces: [
                { partNumber: 'A', quantity: 10 },
                { partNumber: 'B', quantity: 5 }
            ]
        }
    });
    
    global.recalculateMetricsForLot('laser-test');
    
    const lot = Store.getLot('laser-test');
    assert.ok(lot.laserMetrics, 'Debe tener laserMetrics');
    assert.strictEqual(lot.laserMetrics.piezas_grabadas, 15, 'Debe sumar 15 piezas');
});

test('recalculateMetricsForLot calcula métricas pavonado', () => {
    Store.setLocalData({
        'pavonado-test': {
            name: 'Test Pavonado',
            pieces: [
                { partNumber: 'A', quantity: 20 },
                { partNumber: 'B', numPiezas: 8 }  // Campo alternativo
            ]
        }
    });
    
    global.recalculateMetricsForLot('pavonado-test');
    
    const lot = Store.getLot('pavonado-test');
    assert.ok(lot.pavonadoMetrics, 'Debe tener pavonadoMetrics');
    assert.strictEqual(lot.pavonadoMetrics.piezas_pavonadas, 28, 'Debe sumar 28 piezas');
});

test('recalculateMetricsForLot maneja lote vacío', () => {
    Store.setLocalData({
        'laser-empty': {
            name: 'Test Empty',
            pieces: []
        }
    });
    
    global.recalculateMetricsForLot('laser-empty');
    
    const lot = Store.getLot('laser-empty');
    // Cuando es 0, se elimina la métrica
    assert.ok(!lot.laserMetrics?.piezas_grabadas, 'No debe tener piezas_grabadas cuando es 0');
});

test('recalculateMetricsForLot ignora lote inexistente', () => {
    // No debe lanzar error
    global.recalculateMetricsForLot('lote-que-no-existe');
});

// Test: App.features.Pieces existe
test('App.features.Pieces existe', () => {
    assert.ok(global.App, 'App debe existir');
    assert.ok(global.App.features, 'App.features debe existir');
    assert.ok(global.App.features.Pieces, 'App.features.Pieces debe existir');
});

test('App.features.Pieces tiene métodos esperados', () => {
    const Pieces = global.App.features.Pieces;
    assert.ok(typeof Pieces.validate === 'function', 'validate debe existir');
    assert.ok(typeof Pieces.recalculateMetrics === 'function', 'recalculateMetrics debe existir');
});

// ============================================
// RESUMEN
// ============================================

console.log('\n========================================');
console.log(`RESULTADOS: ${passed} pasados, ${failed} fallidos`);
console.log('========================================');

process.exit(failed > 0 ? 1 : 0);
