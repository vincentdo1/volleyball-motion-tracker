import { findModel, type ModelArtifact, type ModelsLock, parseModelsLock } from '@/contracts/models';
import lockJson from '../../../models.lock.json';

let lock: ModelsLock | undefined;

export function modelsLock(): ModelsLock {
  lock ??= parseModelsLock(lockJson);
  return lock;
}

export function artifactById(id: string): ModelArtifact {
  return findModel(modelsLock(), id);
}
