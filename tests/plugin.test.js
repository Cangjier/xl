/**
 * Plugin tests: the service is published, the tools are registered, and the
 * tool surface round-trips the plan channel.
 *
 * @module xl/tests/plugin
 */

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { apply, normalizeConfig, XL_SERVICE } from '../src/plugin/index.js'
import { TOOL_NAMES } from '../src/plugin/tools.js'
import { callTool, dropWorkspace, makeFakeContext, makeWorkspace, read } from './helpers.js'

const DEMO = [
  '# namespace demo',
  'demo package.',
  '',
  '# class point',
  '',
  '## field x:int = 0',
  'x.',
  '',
  '## method move:(dx:int)=>void',
  'move.',
  '```ts',
  'this.x = dx;',
  '```',
  '',
  '### csharp',
  '```csharp',
  'public void Move(int dx) { X += dx; }',
  '```',
  '',
].join('\n')

const CPP_DEMO = [
  '# class point',
  '',
  '## field x:int = 0',
  'x.',
  '',
  '## method move:(dx:int)=>void',
  'move.',
  '```ts',
  'this.x = dx;',
  '```',
  '',
].join('\n')

const CPP_HEADER = [
  '#pragma once',
  '',
  'class point {',
  'public:',
  '  int x = 0;',
  '  void move(int dx);',
  '};',
  '',
].join('\n')

const CPP_SOURCE = [
  '#include "point.h"',
  '',
  'void point::move(int dx) {',
  '  x += dx;',
  '}',
  '',
].join('\n')

/**
 * Mount the plugin on a fake context rooted at a workspace.
 * @param {string} cwd - workspace root.
 * @param {object} [config] - plugin config.
 * @returns {object} the fake context bundle.
 */
function mount(cwd, config = {}) {
  const fake = makeFakeContext()
  apply(fake.ctx, { workspaceRoot: cwd, ...config })
  return fake
}
test('apply publishes the xl service and registers every tool', () => {
  const cwd = makeWorkspace({ 'demo.xl.md': DEMO })
  try {
    const fake = mount(cwd)
    assert.ok(fake.services.has(XL_SERVICE))
    assert.deepEqual([...fake.tools.keys()].sort(), [...TOOL_NAMES].sort())
  } finally {
    dropWorkspace(cwd)
  }
})

test('the tool set is stable and documented', () => {
  assert.deepEqual(TOOL_NAMES, [
    'xl_plan',
    'xl_context',
    'xl_cache',
    'xl_verify',
    'xl_emit',
    'xl_check',
    'xl_build',
  ])
})

test('every tool declares the required registration fields', () => {
  const cwd = makeWorkspace({ 'demo.xl.md': DEMO })
  try {
    const fake = mount(cwd)
    for (const [name, definition] of fake.tools) {
      assert.equal(definition.name, name)
      assert.ok(definition.description.length > 20, `${name} needs a description`)
      assert.equal(definition.parameters.type, 'object')
      assert.equal(typeof definition.execute, 'function')
      assert.equal(typeof definition.output.render, 'function')
      assert.ok(definition.output.schema !== undefined)
    }
  } finally {
    dropWorkspace(cwd)
  }
})

test('normalizeConfig rejects a misconfigured row', () => {
  assert.throws(() => normalizeConfig({ workspaceRoot: 7 }), TypeError)
  assert.throws(() => normalizeConfig({ cacheDir: '' }), TypeError)
  assert.throws(() => normalizeConfig({ defaultTargets: 'ts' }), TypeError)
  assert.throws(() => normalizeConfig({ verifyOnEmit: 'yes' }), TypeError)
  assert.deepEqual(normalizeConfig(undefined), {
    workspaceRoot: null,
    cacheDir: '.xl',
    defaultTargets: ['ts'],
    verifyOnEmit: true,
  })
})

test('xl_plan reports the planned outputs and the channel', async () => {
  const cwd = makeWorkspace({ 'demo.xl.md': DEMO })
  try {
    const fake = mount(cwd)
    const { text, value } = await callTool(fake.tools, 'xl_plan', { targets: ['csharp'], cwd })
    assert.equal(value.exitCode, 0)
    assert.ok(text.includes('dist/csharp/Point.cs'))
    assert.ok(text.includes('produced by you'))
  } finally {
    dropWorkspace(cwd)
  }
})

test('xl_context reports the contract, the language sections, and the next steps', async () => {
  const cwd = makeWorkspace({ 'demo.xl.md': DEMO })
  try {
    const fake = mount(cwd)
    const { text } = await callTool(fake.tools, 'xl_context', { file: 'demo.xl.md', target: 'csharp', cwd })
    assert.ok(text.includes('# xl context'))
    assert.ok(text.includes('"name": "point"'))
    assert.ok(text.includes('X += dx'))
    assert.ok(text.includes('xl_emit'))
  } finally {
    dropWorkspace(cwd)
  }
})

test('xl_cache reports no previous version before the first emit', async () => {
  const cwd = makeWorkspace({ 'demo.xl.md': DEMO })
  try {
    const fake = mount(cwd)
    const { text } = await callTool(fake.tools, 'xl_cache', { file: 'demo.xl.md', target: 'csharp', cwd })
    assert.ok(text.includes('none — nothing has been archived'))
  } finally {
    dropWorkspace(cwd)
  }
})

test('xl_context and xl_emit handle a two-part C++ target', async () => {
  const cwd = makeWorkspace({ 'demo.xl.md': CPP_DEMO })
  try {
    const fake = mount(cwd)
    const opened = await callTool(fake.tools, 'xl_context', { file: 'demo.xl.md', target: 'cpp', cwd })
    assert.ok(opened.text.includes('parts: header, source'))
    assert.ok(opened.text.includes('[header] `dist/cpp/point.h`'))
    assert.ok(opened.text.includes('[source] `dist/cpp/point.cpp`'))
    assert.deepEqual(opened.value.previous, [])

    const files = [
      { path: 'dist/cpp/point.h', content: CPP_HEADER },
      { path: 'dist/cpp/point.cpp', content: CPP_SOURCE },
    ]
    const verified = await callTool(fake.tools, 'xl_verify', { file: 'demo.xl.md', target: 'cpp', files, cwd })
    assert.ok(verified.text.includes('xl verify: ok'))
    const emitted = await callTool(fake.tools, 'xl_emit', { file: 'demo.xl.md', target: 'cpp', files, cwd })
    assert.equal(emitted.value.ok, true)
    assert.deepEqual(emitted.value.written, ['dist/cpp/point.h', 'dist/cpp/point.cpp'])
    assert.ok(existsSync(join(cwd, 'dist/cpp/point.cpp')))

    // A second emit archives each part, and xl_cache offers both back.
    const again = await callTool(fake.tools, 'xl_emit', { file: 'demo.xl.md', target: 'cpp', files, cwd })
    assert.equal(again.value.ok, true)
    const cached = await callTool(fake.tools, 'xl_cache', { file: 'demo.xl.md', target: 'cpp', cwd })
    assert.ok(cached.text.includes('part header'))
    assert.ok(cached.text.includes('part source'))
    assert.deepEqual(cached.value.previous.map(item => [item.part, item.ext, item.version]), [
      ['header', '.h', 1],
      ['source', '.cpp', 1],
    ])
  } finally {
    dropWorkspace(cwd)
  }
})

test('xl_verify then xl_emit writes the product and the header', async () => {
  const cwd = makeWorkspace({ 'demo.xl.md': DEMO })
  try {
    const fake = mount(cwd)
    const content = 'public class point {\n  public int x;\n  public void move(int dx) { X += dx; }\n}\n'
    const files = [{ path: 'dist/csharp/Point.cs', content }]
    const verified = await callTool(fake.tools, 'xl_verify', { file: 'demo.xl.md', target: 'csharp', files, cwd })
    assert.ok(verified.text.includes('xl verify: ok'))
    const emitted = await callTool(fake.tools, 'xl_emit', { file: 'demo.xl.md', target: 'csharp', files, cwd })
    assert.equal(emitted.value.ok, true)
    assert.ok(read(cwd, 'dist/csharp/Point.cs').startsWith('// @generated by xl from demo.xl.md'))
    const cached = await callTool(fake.tools, 'xl_cache', { file: 'demo.xl.md', target: 'csharp', cwd })
    assert.ok(cached.text.includes('context hash:'))
    assert.ok(cached.text.includes('reusable: yes'))
  } finally {
    dropWorkspace(cwd)
  }
})

test('xl_emit refuses a product that breaks the contract', async () => {
  const cwd = makeWorkspace({ 'demo.xl.md': DEMO })
  try {
    const fake = mount(cwd)
    const { value, text } = await callTool(fake.tools, 'xl_emit', {
      file: 'demo.xl.md',
      target: 'csharp',
      files: [{ path: 'dist/csharp/Point.cs', content: 'public class point { }' }],
      cwd,
    })
    assert.equal(value.ok, false)
    assert.ok(text.includes('E4002'))
    assert.equal(existsSync(join(cwd, 'dist/csharp/Point.cs')), false)
  } finally {
    dropWorkspace(cwd)
  }
})

test('xl_check reports diagnostics with their codes', async () => {
  const cwd = makeWorkspace({ 'demo.xl.md': '# struct point\n' })
  try {
    const fake = mount(cwd)
    const { value, text } = await callTool(fake.tools, 'xl_check', { cwd })
    assert.equal(value.ok, false)
    assert.ok(text.includes('E1002'))
  } finally {
    dropWorkspace(cwd)
  }
})

test('xl_build produces ts and plans the other targets', async () => {
  const cwd = makeWorkspace({ 'demo.xl.md': DEMO })
  try {
    const fake = mount(cwd)
    const { value, text } = await callTool(fake.tools, 'xl_build', { targets: ['ts', 'csharp'], cwd })
    assert.equal(value.exitCode, 0)
    assert.ok(read(cwd, 'dist/ts/demo.ts').startsWith('// @generated by xl'))
    assert.equal(existsSync(join(cwd, 'dist/csharp/Point.cs')), false)
    assert.ok(text.includes('planned'))
  } finally {
    dropWorkspace(cwd)
  }
})

test('xl.json build.target is honoured even though the row supplies defaultTargets', async () => {
  const config = JSON.stringify({ build: { target: ['csharp'] } })
  const cwd = makeWorkspace({ 'demo.xl.md': DEMO, 'xl.json': config })
  try {
    const fake = mount(cwd)
    const { value, text } = await callTool(fake.tools, 'xl_build', { cwd })
    assert.deepEqual(value.files.map(file => file.target), ['csharp'])
    assert.ok(text.includes('produced by you') || text.includes('planned'))
  } finally {
    dropWorkspace(cwd)
  }
})

test('xl_plan and xl_emit agree on flat and preserve naming', async () => {
  const cwd = makeWorkspace({ 'pkg/demo.xl.md': DEMO })
  try {
    const fake = mount(cwd)
    const planned = await callTool(fake.tools, 'xl_plan', { targets: ['csharp'], flat: true, naming: 'preserve', cwd })
    assert.ok(planned.text.includes('dist/csharp/point.cs'))

    const files = [{
      path: 'dist/csharp/point.cs',
      content: 'public class point {\n  public int x;\n  public void move(int dx) { X += dx; }\n}\n',
    }]
    const verified = await callTool(fake.tools, 'xl_verify', {
      file: 'pkg/demo.xl.md', target: 'csharp', files, flat: true, naming: 'preserve', cwd,
    })
    assert.ok(verified.text.includes('xl verify: ok'))
    const emitted = await callTool(fake.tools, 'xl_emit', {
      file: 'pkg/demo.xl.md', target: 'csharp', files, flat: true, naming: 'preserve', cwd,
    })
    assert.equal(emitted.value.ok, true)
    assert.deepEqual(emitted.value.written, ['dist/csharp/point.cs'])
  } finally {
    dropWorkspace(cwd)
  }
})

test('xl_emit without the plan options refuses the mismatched path', async () => {
  const cwd = makeWorkspace({ 'pkg/demo.xl.md': DEMO })
  try {
    const fake = mount(cwd)
    const emitted = await callTool(fake.tools, 'xl_emit', {
      file: 'pkg/demo.xl.md',
      target: 'csharp',
      files: [{ path: 'dist/csharp/Point.cs', content: 'public class point { }' }],
      flat: true,
      naming: 'preserve',
      cwd,
    })
    assert.equal(emitted.value.ok, false)
    assert.ok(emitted.text.includes('E2001'))
  } finally {
    dropWorkspace(cwd)
  }
})

test('the workspace root config makes cwd optional', async () => {
  const cwd = makeWorkspace({ 'demo.xl.md': DEMO })
  try {
    const fake = mount(cwd)
    const { value } = await callTool(fake.tools, 'xl_plan', { target: ['ts'] })
    assert.equal(value.exitCode, 0)
  } finally {
    dropWorkspace(cwd)
  }
})
