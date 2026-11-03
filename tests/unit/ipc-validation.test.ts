import { describe, expect, it } from 'vitest';
import { IPC_VERSION } from '../../src/shared/ipc/contracts';
import {
  isDiagnosticsResult,
  isPluginLifecycleRequest,
  isPluginSnapshotEvent,
  isRendererReadyMessage,
  isRendererTransportAck,
  isRendererTransportRequest,
  isRequestBase,
  isServiceRequest,
  isServiceResult,
} from '../../src/shared/ipc/validate';

describe('versioned IPC runtime validation', () => {
  it('accepts only the current exact request envelope', () => {
    expect(isRequestBase({ version: IPC_VERSION, requestId: 'open:1' })).toBe(true);
    expect(isRequestBase({ version: 2, requestId: 'open:1' })).toBe(false);
    expect(isRequestBase({ version: 1, requestId: 'open:1', channel: 'arbitrary' })).toBe(false);
  });

  it('allows only declared service actions', () => {
    expect(isServiceRequest({ version: 1, requestId: 'service:1', action: 'grant-read', generation: 3 })).toBe(true);
    expect(isServiceRequest({ version: 1, requestId: 'service:missing-generation', action: 'grant-read' })).toBe(false);
    expect(isServiceRequest({ version: 1, requestId: 'service:2', action: 'shell' })).toBe(false);
  });

  it('fails closed on malformed successes, malformed errors, and wrong requests', () => {
    expect(isServiceResult({ ok: true, requestId: 'service:1', value: { state: 'read', sha256: 'bad', size: -1 } }, 'service:1')).toBe(false);
    expect(isDiagnosticsResult({ ok: true, requestId: 'diagnostics:1', value: { renderer: { consoleErrors: -1 } } }, 'diagnostics:1')).toBe(false);
    expect(isServiceResult({ ok: false, requestId: 'service:1', error: { code: 'UNKNOWN', message: 'no' } }, 'service:1')).toBe(false);
    expect(isDiagnosticsResult({ ok: true, requestId: 'diagnostics:wrong', value: {} }, 'diagnostics:1')).toBe(false);
  });

  it('accepts bounded third-party plugin IDs without granting catalog membership', () => {
    expect(isPluginLifecycleRequest({
      version: 1,
      requestId: 'plugin:third-party',
      action: 'enable',
      pluginId: 'org.example.notes.focus',
    })).toBe(true);
    expect(isPluginLifecycleRequest({
      version: 1,
      requestId: 'plugin:invalid',
      action: 'enable',
      pluginId: 'Bad Plugin',
    })).toBe(false);
  });

  it('bounds and deduplicates plugin snapshots', () => {
    const snapshot = (id: string) => ({
      id,
      manifestVersion: '1.0.0',
      desiredEnabled: false,
      lifecycle: 'disabled',
      settings: {},
      activeGeneration: null,
      leaseCount: 0,
      rendererRegistrations: 0,
      activationReason: null,
      persistenceHealth: 'healthy',
      lastFailure: null,
      capability: { grant: null, request: null, restartRequired: false },
      presentation: { name: 'Test', description: '', origin: 'bundled', commands: [], hotkeys: [], install: null },
    });
    expect(isPluginSnapshotEvent({ version: 1, snapshots: [snapshot('org.example.one')] })).toBe(true);
    expect(isPluginSnapshotEvent({
      version: 1,
      snapshots: [{ ...snapshot('org.example.discovered'), lifecycle: 'discovered' }],
    })).toBe(true);
    expect(isPluginSnapshotEvent({ version: 1, snapshots: [snapshot('org.example.one'), snapshot('org.example.one')] })).toBe(false);
    expect(isPluginSnapshotEvent({ version: 1, snapshots: Array.from({ length: 65 }, (_, index) => snapshot(`org.example.p${index}`)) })).toBe(false);
  });

  it('requires exact renderer session envelopes', () => {
    const rendererSessionId = '22222222-2222-4222-8222-222222222222';
    expect(isRendererReadyMessage({ version: 1, rendererSessionId })).toBe(true);
    expect(isRendererReadyMessage({ version: 1, rendererSessionId, extra: true })).toBe(false);
    const request = {
      version: 1,
      requestId: 'renderer:bridge:1',
      rendererSessionId,
      action: 'close',
      pluginId: 'org.example.plugin',
      leaseId: 'lease:example',
      generation: 1,
    };
    expect(isRendererTransportRequest(request)).toBe(true);
    expect(isRendererTransportRequest({ ...request, rendererSessionId: 'stale' })).toBe(false);
    expect(isRendererTransportRequest({ ...request, extra: true })).toBe(false);

    const negativeAck = {
      ...request,
      ok: false,
      error: 'PLUGIN_GENERATION_STALE',
    };
    expect(isRendererTransportAck(negativeAck)).toBe(true);
    expect(isRendererTransportAck({
      ...negativeAck,
      error: 'PLUGIN_FAILED: /Users/private/secret.md token=password',
    })).toBe(false);

    const closeAck = {
      ...request,
      ok: true,
      complete: false,
      failures: ['PLUGIN_FAILED'],
      registrations: 0,
    };
    expect(isRendererTransportAck(closeAck)).toBe(true);
    expect(isRendererTransportAck({
      ...closeAck,
      failures: ['password=renderer-child-secret'],
    })).toBe(false);
  });
});
