import {
  NOTO_UPDATES_VERSION,
  UPDATE_CHANNEL_VALUES,
  type UpdateChannelV1,
  type UpdatePhaseV1,
  type UpdateRequestV1,
  type UpdateResultV1,
  type UpdateStatusV1,
} from './contracts';

const requestId = /^[A-Za-z0-9._:-]{1,96}$/;
const phases: readonly UpdatePhaseV1[] = [
  'idle', 'checking', 'up-to-date', 'available', 'downloading', 'downloaded', 'error', 'unsupported',
];

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export function isUpdateChannelV1(value: unknown): value is UpdateChannelV1 {
  return (UPDATE_CHANNEL_VALUES as readonly unknown[]).includes(value);
}

export function isUpdateRequestV1(value: unknown): value is UpdateRequestV1 {
  return record(value) && value.version === NOTO_UPDATES_VERSION
    && Object.keys(value).length === 2
    && typeof value.requestId === 'string' && requestId.test(value.requestId);
}

export function isUpdateStatusV1(value: unknown): value is UpdateStatusV1 {
  if (!record(value) || value.version !== NOTO_UPDATES_VERSION) return false;
  return phases.includes(value.phase as UpdatePhaseV1)
    && typeof value.currentVersion === 'string' && value.currentVersion.length <= 64
    && isUpdateChannelV1(value.channel)
    && (value.availableVersion === null
      || (typeof value.availableVersion === 'string' && value.availableVersion.length <= 64))
    && (value.releaseUrl === null
      || (typeof value.releaseUrl === 'string' && value.releaseUrl.length <= 512))
    && typeof value.problem === 'string' && value.problem.length <= 512
    && typeof value.canAutoInstall === 'boolean'
    && typeof value.packaged === 'boolean';
}

export function isUpdateResultV1(
  value: unknown,
  expectedRequestId: string,
): value is UpdateResultV1<UpdateStatusV1> {
  if (!record(value) || value.requestId !== expectedRequestId) return false;
  if (value.ok === true) return isUpdateStatusV1(value.value);
  return value.ok === false && record(value.error)
    && typeof value.error.code === 'string' && typeof value.error.message === 'string';
}
