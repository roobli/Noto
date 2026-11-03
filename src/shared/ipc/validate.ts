import { validatePluginManifest } from '../plugins/manifest';
import { NOTO_ERROR_CODES, type NotoError } from '../errors';
import {
  PLUGIN_LIFECYCLE_VERSION,
  isRendererTransportFailureCode,
  type PluginActivationReason,
  type PluginLifecycleAction,
  type PluginLifecycleReply,
  type PluginLifecycleRequest,
  type PluginLifecycleSnapshot,
  type PluginSnapshotEvent,
  type RendererTransportAck,
  type RendererTransportRequest,
  type RendererReadyMessage,
} from '../plugins/lifecycle';
import {
  IPC_VERSION,
  type DiagnosticsReply,
  type DiagnosticsRequest,
  type RequestBase,
  type Result,
  type ServiceReply,
  type ServiceOperationReply,
  type ServiceRequest,
} from './contracts';

const requestIdPattern = /^[a-zA-Z0-9._:-]{1,96}$/;
const hashPattern = /^[a-f0-9]{64}$/;
const grantIdPattern = /^grant:[a-f0-9-]{36}$/;
const MAX_COUNTER = 1_000_000;
const lifecycleStates = [
  'discovered', 'disabled', 'enabled-idle', 'activating', 'active', 'deactivating', 'failed', 'crashed',
] as const;
const persistenceHealth = ['healthy', 'degraded', 'indeterminate'] as const;
const pluginIdPattern = /^[a-z0-9]+(?:[.-][a-z0-9]+)+$/;
const rendererSessionIdPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const capabilityGrantStates = ['active', 'revoking', 'revoked'] as const;
const capabilityRequestStates = ['pending', 'cancelling', 'completed', 'cancelled', 'timed-out', 'failed'] as const;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function isBoundedString(value: unknown, max: number, allowEmpty = false): value is string {
  return typeof value === 'string' && value.length <= max && (allowEmpty || value.length > 0);
}

function isBoundedCounter(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= MAX_COUNTER;
}

function isGeneration(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= MAX_COUNTER;
}

function isNullableGeneration(value: unknown): value is number | null {
  return value === null || isGeneration(value);
}

function isHash(value: unknown): value is string {
  return typeof value === 'string' && hashPattern.test(value);
}

function isNotoError(value: unknown): value is NotoError {
  return isRecord(value)
    && hasExactKeys(value, ['code', 'message'])
    && typeof value.code === 'string'
    && NOTO_ERROR_CODES.includes(value.code as NotoError['code'])
    && isBoundedString(value.message, 2_048);
}

export function isRequestBase(value: unknown): value is RequestBase {
  return isRecord(value)
    && hasExactKeys(value, ['version', 'requestId'])
    && value.version === IPC_VERSION
    && typeof value.requestId === 'string'
    && requestIdPattern.test(value.requestId);
}

function isPluginId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 80 && pluginIdPattern.test(value);
}

function isLeaseId(value: unknown): value is string {
  return typeof value === 'string'
    && /^lease:[a-zA-Z0-9._:-]{1,96}$/.test(value);
}

function isBooleanSettings(value: unknown): value is Record<string, boolean> {
  return isRecord(value)
    && Object.keys(value).length <= 32
    && Object.keys(value).every((key) => /^[a-z][a-zA-Z0-9.-]{0,79}$/.test(key))
    && Object.values(value).every((setting) => typeof setting === 'boolean');
}

function isActivationReason(value: unknown): value is PluginActivationReason {
  if (!isRecord(value) || typeof value.type !== 'string') return false;
  if (value.type === 'startup') return hasExactKeys(value, ['type']);
  if (value.type === 'event') {
    return hasExactKeys(value, ['type', 'event']) && isBoundedString(value.event, 80);
  }
  if (value.type === 'hotkey') {
    return hasExactKeys(value, ['type', 'keys']) && isBoundedString(value.keys, 80);
  }
  return value.type === 'command'
    && hasExactKeys(value, ['type', 'commandId'])
    && isBoundedString(value.commandId, 80);
}

function isCapabilitySnapshot(value: unknown): boolean {
  if (!isRecord(value) || !hasExactKeys(value, ['grant', 'request', 'restartRequired'])) return false;
  const grant = value.grant;
  const request = value.request;
  const validGrant = grant === null || (isRecord(grant)
    && hasExactKeys(grant, ['id', 'generation', 'root', 'state'])
    && typeof grant.id === 'string' && grantIdPattern.test(grant.id)
    && isGeneration(grant.generation)
    && isBoundedString(grant.root, 256)
    && !/[\\/]/.test(grant.root)
    && capabilityGrantStates.includes(grant.state as typeof capabilityGrantStates[number]));
  const validRequest = request === null || (isRecord(request)
    && hasExactKeys(request, ['requestId', 'generation', 'action', 'state', 'detail'])
    && typeof request.requestId === 'string' && requestIdPattern.test(request.requestId)
    && isGeneration(request.generation)
    && ['read-granted', 'deny-probe'].includes(String(request.action))
    && capabilityRequestStates.includes(request.state as typeof capabilityRequestStates[number])
    && isBoundedString(request.detail, 512, true));
  return validGrant && validRequest && typeof value.restartRequired === 'boolean';
}

export function isPluginLifecycleSnapshot(value: unknown): value is PluginLifecycleSnapshot {
  if (!isRecord(value)
    || !hasExactKeys(value, [
      'id', 'manifestVersion', 'desiredEnabled', 'lifecycle', 'settings', 'activeGeneration',
      'leaseCount', 'rendererRegistrations', 'activationReason', 'persistenceHealth', 'lastFailure', 'capability',
      'presentation',
    ])
    || !isPluginId(value.id)
    || !isBoundedString(value.manifestVersion, 256)
    || typeof value.desiredEnabled !== 'boolean'
    || !lifecycleStates.includes(value.lifecycle as typeof lifecycleStates[number])
    || !isBooleanSettings(value.settings)
    || !isNullableGeneration(value.activeGeneration)
    || !isBoundedCounter(value.leaseCount)
    || !isBoundedCounter(value.rendererRegistrations)
    || !(value.activationReason === null || isActivationReason(value.activationReason))
    || !persistenceHealth.includes(value.persistenceHealth as typeof persistenceHealth[number])
    || !(value.lastFailure === null || isBoundedString(value.lastFailure, 2_048))
    || !isCapabilitySnapshot(value.capability)
    || !isPresentationSnapshot(value.presentation)) return false;
  return !Object.values(value.settings).some((setting) => typeof setting !== 'boolean');
}

/** How the renderer loads an installed plugin: only from its own pinned address. */
function isInstallPresentation(value: unknown): boolean {
  if (!isRecord(value) || !hasExactKeys(value, ['source', 'trust', 'codeUrl', 'manifest'])) return false;
  const manifest = value.manifest;
  if (!validatePluginManifest(manifest) || manifest.runtime !== 'sandboxed') return false;
  const id = manifest.id;
  return isBoundedString(value.source, 120)
    && (value.trust === 'sandboxed' || value.trust === 'full')
    && typeof value.codeUrl === 'string'
    && new RegExp(value.trust === 'full'
      ? `^noto://bundle/plugins/${id.replace(/[.]/g, '\\.')}/[0-9a-f]{64}/main\\.js$`
      : `^noto://plugin-code/${id.replace(/[.]/g, '\\.')}/[0-9a-f]{64}/main\\.js$`).test(value.codeUrl);
}

/** A plugin's name and what it adds, bounded as the manifest validator bounds them. */
function isPresentationSnapshot(value: unknown): boolean {
  return isRecord(value)
    && hasExactKeys(value, ['name', 'description', 'origin', 'commands', 'hotkeys', 'install'])
    && (value.install === null || isInstallPresentation(value.install))
    && isBoundedString(value.name, 80)
    && isBoundedString(value.description, 200, true)
    && (value.origin === 'bundled' || value.origin === 'user')
    && Array.isArray(value.commands) && value.commands.length <= 32
    && value.commands.every((command) => isRecord(command) && hasExactKeys(command, ['id', 'title'])
      && isBoundedString(command.id, 128) && isBoundedString(command.title, 120))
    && Array.isArray(value.hotkeys) && value.hotkeys.length <= 32
    && value.hotkeys.every((hotkey) => isRecord(hotkey) && hasExactKeys(hotkey, ['command', 'keys'])
      && isBoundedString(hotkey.command, 128) && isBoundedString(hotkey.keys, 64));
}

function isSnapshotList(value: unknown): value is PluginLifecycleSnapshot[] {
  return Array.isArray(value)
    && value.length <= 64
    && value.every(isPluginLifecycleSnapshot)
    && new Set(value.map((snapshot) => snapshot.id)).size === value.length;
}

export function isPluginLifecycleRequest(value: unknown): value is PluginLifecycleRequest {
  if (!isRecord(value)
    || value.version !== PLUGIN_LIFECYCLE_VERSION
    || typeof value.requestId !== 'string'
    || !requestIdPattern.test(value.requestId)
    || typeof value.action !== 'string') return false;
  switch (value.action) {
    case 'get-snapshots':
    case 'trigger-startup':
      return hasExactKeys(value, ['version', 'requestId', 'action']);
    case 'enable':
    case 'disable':
      return hasExactKeys(value, ['version', 'requestId', 'action', 'pluginId'])
        && isPluginId(value.pluginId);
    case 'trigger-event':
      return hasExactKeys(value, ['version', 'requestId', 'action', 'event'])
        && isBoundedString(value.event, 80);
    case 'trigger-hotkey':
      return hasExactKeys(value, ['version', 'requestId', 'action', 'keys'])
        && isBoundedString(value.keys, 80);
    case 'execute-command':
      return hasExactKeys(value, ['version', 'requestId', 'action', 'pluginId', 'commandId'])
        && isPluginId(value.pluginId)
        && isBoundedString(value.commandId, 80);
    case 'set-setting':
      return hasExactKeys(value, ['version', 'requestId', 'action', 'pluginId', 'key', 'value'])
        && isPluginId(value.pluginId)
        && isBoundedString(value.key, 80)
        && typeof value.value === 'boolean';
    case 'replace-generation':
      return hasExactKeys(value, ['version', 'requestId', 'action', 'pluginId', 'reason'])
        && isPluginId(value.pluginId)
        && isActivationReason(value.reason);
    case 'renderer-disposed':
      return hasExactKeys(value, [
        'version', 'requestId', 'action', 'pluginId', 'leaseId', 'generation',
      ])
        && isPluginId(value.pluginId)
        && isLeaseId(value.leaseId)
        && isGeneration(value.generation);
    default:
      return false;
  }
}

function isPluginLifecycleReply(value: unknown, action: PluginLifecycleAction): value is PluginLifecycleReply {
  return isRecord(value)
    && hasExactKeys(value, ['version', 'action', 'snapshots', 'handled'])
    && value.version === PLUGIN_LIFECYCLE_VERSION
    && value.action === action
    && isSnapshotList(value.snapshots)
    && (value.handled === null || typeof value.handled === 'boolean');
}

export function isPluginLifecycleResult(
  value: unknown,
  requestId: string,
  action: PluginLifecycleAction,
): value is Result<PluginLifecycleReply> {
  return isTypedResult(value, requestId, (candidate): candidate is PluginLifecycleReply =>
    isPluginLifecycleReply(candidate, action));
}

export function isPluginSnapshotEvent(value: unknown): value is PluginSnapshotEvent {
  return isRecord(value)
    && hasExactKeys(value, ['version', 'snapshots'])
    && value.version === PLUGIN_LIFECYCLE_VERSION
    && isSnapshotList(value.snapshots);
}

function isRendererTransportBase(value: Record<string, unknown>): boolean {
  return value.version === PLUGIN_LIFECYCLE_VERSION
    && typeof value.requestId === 'string' && requestIdPattern.test(value.requestId)
    && typeof value.rendererSessionId === 'string'
    && rendererSessionIdPattern.test(value.rendererSessionId)
    && isPluginId(value.pluginId)
    && isLeaseId(value.leaseId)
    && isGeneration(value.generation);
}

export function isRendererTransportRequest(value: unknown): value is RendererTransportRequest {
  if (!isRecord(value) || !isRendererTransportBase(value)) return false;
  switch (value.action) {
    case 'open':
      return hasExactKeys(value, [
        'version', 'requestId', 'rendererSessionId', 'action', 'pluginId', 'leaseId', 'generation', 'settings',
      ]) && isBooleanSettings(value.settings);
    case 'close':
      return hasExactKeys(value, [
        'version', 'requestId', 'rendererSessionId', 'action', 'pluginId', 'leaseId', 'generation',
      ]);
    case 'execute-command':
      return hasExactKeys(value, [
        'version', 'requestId', 'rendererSessionId', 'action', 'pluginId', 'leaseId', 'generation', 'commandId',
      ]) && isBoundedString(value.commandId, 80);
    case 'update-setting':
      return hasExactKeys(value, [
        'version', 'requestId', 'rendererSessionId', 'action', 'pluginId', 'leaseId', 'generation', 'key', 'value',
      ]) && isBoundedString(value.key, 80) && typeof value.value === 'boolean';
    default:
      return false;
  }
}

export function isRendererTransportAck(value: unknown): value is RendererTransportAck {
  if (!isRecord(value)
    || !isRendererTransportBase(value)
    || typeof value.action !== 'string'
    || typeof value.ok !== 'boolean') return false;
  if (!value.ok) {
    return hasExactKeys(value, [
      'version', 'requestId', 'rendererSessionId', 'action', 'ok', 'pluginId', 'leaseId', 'generation', 'error',
    ])
      && ['open', 'close', 'execute-command', 'update-setting'].includes(value.action)
      && isRendererTransportFailureCode(value.error);
  }
  if (value.action === 'open') {
    return hasExactKeys(value, [
      'version', 'requestId', 'rendererSessionId', 'action', 'ok', 'pluginId', 'leaseId', 'generation', 'registrations',
    ]) && isBoundedCounter(value.registrations);
  }
  if (value.action === 'close') {
    return hasExactKeys(value, [
      'version', 'requestId', 'rendererSessionId', 'action', 'ok', 'pluginId', 'leaseId', 'generation',
      'complete', 'failures', 'registrations',
    ])
      && typeof value.complete === 'boolean'
      && Array.isArray(value.failures)
      && value.failures.length <= 32
      && value.failures.every(isRendererTransportFailureCode)
      && value.registrations === 0;
  }
  if (value.action === 'execute-command') {
    return hasExactKeys(value, [
      'version', 'requestId', 'rendererSessionId', 'action', 'ok', 'pluginId', 'leaseId', 'generation', 'handled',
    ]) && typeof value.handled === 'boolean';
  }
  return value.action === 'update-setting'
    && hasExactKeys(value, [
      'version', 'requestId', 'rendererSessionId', 'action', 'ok', 'pluginId', 'leaseId', 'generation',
    ]);
}

export function isRendererReadyMessage(value: unknown): value is RendererReadyMessage {
  return isRecord(value)
    && hasExactKeys(value, ['version', 'rendererSessionId'])
    && value.version === PLUGIN_LIFECYCLE_VERSION
    && typeof value.rendererSessionId === 'string'
    && rendererSessionIdPattern.test(value.rendererSessionId);
}

export function isServiceRequest(value: unknown): value is ServiceRequest {
  if (!isRecord(value)
    || value.version !== IPC_VERSION
    || typeof value.requestId !== 'string'
    || !requestIdPattern.test(value.requestId)
    || !isGeneration(value.generation)
    || typeof value.action !== 'string') {
    return false;
  }
  if (value.action === 'grant-read') {
    return hasExactKeys(value, ['version', 'requestId', 'generation', 'action']);
  }
  if (['read-granted', 'deny-probe', 'revoke-grant'].includes(value.action)) {
    return hasExactKeys(value, ['version', 'requestId', 'generation', 'action', 'grantId'])
      && typeof value.grantId === 'string' && grantIdPattern.test(value.grantId);
  }
  return value.action === 'cancel-request'
    && hasExactKeys(value, ['version', 'requestId', 'generation', 'action', 'targetRequestId'])
    && typeof value.targetRequestId === 'string'
    && requestIdPattern.test(value.targetRequestId);
}

export function isDiagnosticsRequest(value: unknown): value is DiagnosticsRequest {
  return isRequestBase(value);
}

function isServiceReply(value: unknown): value is ServiceReply {
  if (!isRecord(value) || !isGeneration(value.generation)) return false;
  if (value.state === 'granted') {
    return hasExactKeys(value, ['state', 'grantId', 'root', 'generation'])
      && typeof value.grantId === 'string' && grantIdPattern.test(value.grantId)
      && isBoundedString(value.root, 256)
      && !/[\\/]/.test(value.root);
  }
  if (value.state === 'read') {
    return hasExactKeys(value, ['state', 'sha256', 'size', 'generation'])
      && isHash(value.sha256)
      && isBoundedCounter(value.size);
  }
  if (value.state === 'revoked') {
    return hasExactKeys(value, ['state', 'grantId', 'generation'])
      && typeof value.grantId === 'string' && grantIdPattern.test(value.grantId);
  }
  return value.state === 'cancelled'
    && hasExactKeys(value, ['state', 'targetRequestId', 'generation'])
    && typeof value.targetRequestId === 'string'
    && requestIdPattern.test(value.targetRequestId);
}

function isServiceOperationReply(value: unknown): value is ServiceOperationReply {
  if (!isRecord(value)
    || !['grant-read', 'read-granted', 'deny-probe', 'revoke-grant', 'cancel-request'].includes(String(value.action))
    || !isPluginLifecycleSnapshot(value.snapshot)) return false;
  const { action: _action, snapshot: _snapshot, ...reply } = value;
  if (!isServiceReply(reply)) return false;
  if (value.action === 'grant-read') return reply.state === 'granted';
  if (value.action === 'read-granted' || value.action === 'deny-probe') return reply.state === 'read';
  if (value.action === 'revoke-grant') return reply.state === 'revoked';
  return value.action === 'cancel-request' && reply.state === 'cancelled';
}

function isDiagnosticsReply(value: unknown): value is DiagnosticsReply {
  if (!isRecord(value) || !hasExactKeys(value, ['renderer', 'service'])) return false;
  const renderer = value.renderer;
  const service = value.service;
  return isRecord(renderer)
    && hasExactKeys(renderer, ['consoleErrors', 'consoleWarnings'])
    && isBoundedCounter(renderer.consoleErrors)
    && isBoundedCounter(renderer.consoleWarnings)
    && isRecord(service)
    && hasExactKeys(service, [
      'denials', 'dispatched', 'failures', 'grants', 'received', 'generation', 'state', 'permissionProbe',
    ])
    && isBoundedCounter(service.denials)
    && isBoundedCounter(service.dispatched)
    && isBoundedCounter(service.failures)
    && isBoundedCounter(service.grants)
    && isBoundedCounter(service.received)
    && isNullableGeneration(service.generation)
    && ['failed', 'starting', 'stopping', 'stopped', 'ready'].includes(String(service.state))
    && ['failed', 'passed', 'pending'].includes(String(service.permissionProbe));
}

function isTypedResult<T>(
  value: unknown,
  requestId: string,
  validateValue: (candidate: unknown) => candidate is T,
): value is Result<T> {
  if (!isRecord(value)
    || typeof value.requestId !== 'string'
    || value.requestId !== requestId
    || !requestIdPattern.test(value.requestId)
    || typeof value.ok !== 'boolean') return false;
  if (value.ok) {
    return hasExactKeys(value, ['ok', 'requestId', 'value']) && validateValue(value.value);
  }
  return hasExactKeys(value, ['ok', 'requestId', 'error']) && isNotoError(value.error);
}

export const isServiceResult = (value: unknown, requestId: string): value is Result<ServiceOperationReply> =>
  isTypedResult(value, requestId, isServiceOperationReply);
export const isDiagnosticsResult = (value: unknown, requestId: string): value is Result<DiagnosticsReply> =>
  isTypedResult(value, requestId, isDiagnosticsReply);
