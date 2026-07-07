// Tests unitarios para Store - Estado centralizado
// Ejecutar con: node tests/store.test.js

const assert = require('assert');

// Simular entorno de navegador
global.window = global;
global.console = console;

// Cargar Store
require('../public/app/state/store.js');

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

// Test: Store existe y tiene métodos básicos
test('Store existe', () => {
    assert.ok(Store, 'Store debe existir');
});

test('Store.getLocalData devuelve objeto', () => {
    const data = Store.getLocalData();
    assert.strictEqual(typeof data, 'object', 'getLocalData debe devolver objeto');
});

test('Store.setLocalData actualiza datos', () => {
    const testData = { 'test-lot': { name: 'Test', pieces: [] } };
    Store.setLocalData(testData);
    const data = Store.getLocalData();
    assert.deepStrictEqual(data, testData, 'setLocalData debe actualizar datos');
});

test('Store.getLot devuelve lote existente', () => {
    Store.setLocalData({ 'lot-1': { name: 'Lote 1', pieces: [{ partNumber: 'A1' }] } });
    const lot = Store.getLot('lot-1');
    assert.ok(lot, 'getLot debe devolver el lote');
    assert.strictEqual(lot.name, 'Lote 1', 'El nombre debe coincidir');
});

test('Store.getLot devuelve null para lote inexistente', () => {
    const lot = Store.getLot('inexistente');
    assert.strictEqual(lot, null, 'getLot debe devolver null para lote inexistente');
});

test('Store.setLot crea/actualiza lote', () => {
    Store.setLot('lot-new', { name: 'Nuevo', pieces: [] });
    const lot = Store.getLot('lot-new');
    assert.ok(lot, 'setLot debe crear el lote');
    assert.strictEqual(lot.name, 'Nuevo', 'El nombre debe coincidir');
});

test('Store.deleteLot elimina lote', () => {
    Store.setLot('lot-delete', { name: 'Para borrar', pieces: [] });
    assert.ok(Store.getLot('lot-delete'), 'El lote debe existir antes de eliminar');
    Store.deleteLot('lot-delete');
    assert.strictEqual(Store.getLot('lot-delete'), null, 'El lote no debe existir después de eliminar');
});

test('Store.getAllLotKeys devuelve claves', () => {
    Store.setLocalData({ 'a': {}, 'b': {}, 'c': {} });
    const keys = Store.getAllLotKeys();
    assert.ok(Array.isArray(keys), 'getAllLotKeys debe devolver array');
    assert.strictEqual(keys.length, 3, 'Debe tener 3 claves');
    assert.ok(keys.includes('a'), 'Debe incluir clave a');
});

test('Store.isServerConnected devuelve boolean', () => {
    const connected = Store.isServerConnected();
    assert.strictEqual(typeof connected, 'boolean', 'isServerConnected debe devolver boolean');
});

test('Store.setServerConnected actualiza estado', () => {
    Store.setServerConnected(true);
    assert.strictEqual(Store.isServerConnected(), true, 'Debe estar conectado');
    Store.setServerConnected(false);
    assert.strictEqual(Store.isServerConnected(), false, 'Debe estar desconectado');
});

test('Store.isWhatsAppConnected devuelve boolean', () => {
    const connected = Store.isWhatsAppConnected();
    assert.strictEqual(typeof connected, 'boolean', 'isWhatsAppConnected debe devolver boolean');
});

test('Store.getCurrentPageLotes devuelve número', () => {
    const page = Store.getCurrentPageLotes();
    assert.strictEqual(typeof page, 'number', 'getCurrentPageLotes debe devolver número');
});

test('Store.setCurrentPageLotes actualiza página', () => {
    Store.setCurrentPageLotes(5);
    assert.strictEqual(Store.getCurrentPageLotes(), 5, 'Página debe ser 5');
    Store.setCurrentPageLotes(0);
});

test('Store.getCurrentRegistroLot devuelve string', () => {
    const lot = Store.getCurrentRegistroLot();
    assert.strictEqual(typeof lot, 'string', 'getCurrentRegistroLot debe devolver string');
});

test('Store.setCurrentRegistroLot actualiza lote actual', () => {
    Store.setCurrentRegistroLot('laser-test');
    assert.strictEqual(Store.getCurrentRegistroLot(), 'laser-test', 'Lote actual debe ser laser-test');
    Store.setCurrentRegistroLot('lotes');
});

test('window.localData es un proxy al Store', () => {
    Store.setLocalData({ 'proxy-test': { name: 'Test' } });
    assert.ok(global.localData['proxy-test'], 'localData debe acceder a los datos del Store');
    assert.strictEqual(global.localData['proxy-test'].name, 'Test', 'Nombre debe coincidir');
});

test('window.markLocalDataDirty existe y no lanza error', () => {
    assert.ok(typeof global.markLocalDataDirty === 'function', 'markLocalDataDirty debe ser función');
    // No debe lanzar error
    global.markLocalDataDirty('test');
});

// ============================================
// RESUMEN
// ============================================

console.log('\n========================================');
console.log(`RESULTADOS: ${passed} pasados, ${failed} fallidos`);
console.log('========================================');

process.exit(failed > 0 ? 1 : 0);
