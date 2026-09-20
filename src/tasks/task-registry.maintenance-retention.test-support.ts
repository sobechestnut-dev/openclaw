// Register these cases inside the task-registry suite's existing lifecycle fixture.
import { expect, it, vi } from "vitest";
import * as databaseIdentity from "../infra/sqlite-worker-identity.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { createInMemoryTaskRegistryStore } from "../test-utils/task-registry-store.js";
import { finalizeTaskRecordByRunId, getTaskById, listTaskRecords } from "./runtime-internal.js";
import {
  previewTaskRegistryMaintenance,
  runTaskRegistryMaintenance,
  sweepTaskRegistry,
} from "./task-registry.maintenance.js";
import { configureTaskRegistryRuntime } from "./task-registry.store.js";
import { createTaskFixture, withTaskRegistryTempDir } from "./task-registry.test-support.js";

export function registerTaskRegistryMaintenanceRetentionTests() {
  it("prunes old terminal tasks during maintenance sweeps", async () => {
    const retiredIdentity = await withTaskRegistryTempDir(async () => {
      const database = openOpenClawStateDatabase();
      return databaseIdentity.readDatabasePathIdentitySync(database.path);
    });
    const readIdentity = databaseIdentity.readDatabasePathIdentitySync;
    let creationPath = "";
    // Model Linux inode reuse while retaining the real worker and sweep.
    const identityRead = vi
      .spyOn(databaseIdentity, "readDatabasePathIdentitySync")
      .mockImplementation((pathname) => {
        const identity = readIdentity(pathname);
        return pathname === creationPath && identity.key.startsWith("file:")
          ? { ...identity, key: retiredIdentity.key }
          : identity;
      });
    try {
      await withTaskRegistryTempDir(async () => {
        creationPath = captureOpenClawStateWorkerContext().admission.databasePath;
        createTaskFixture("cli", {
          childSessionKey: "agent:main:main",
          runId: "run-prune",
          task: "Old completed task",
          status: "succeeded",
          startedAt: Date.now() - 9 * 24 * 60 * 60_000,
          lastEventAt: Date.now() - 8 * 24 * 60 * 60_000,
        });
        finalizeTaskRecordByRunId({
          runId: "run-prune",
          runtime: "cli",
          status: "succeeded",
          endedAt: Date.now() - 8 * 24 * 60 * 60_000,
          lastEventAt: Date.now() - 8 * 24 * 60 * 60_000,
        });

        expect(await sweepTaskRegistry()).toEqual({
          reconciled: 0,
          recovered: 0,
          cleanupStamped: 0,
          pruned: 1,
        });
        expect(listTaskRecords()).toStrictEqual([]);
      });
    } finally {
      identityRead.mockRestore();
    }
  });

  it("previews and repairs missing cleanup timestamps during maintenance", async () => {
    await withTaskRegistryTempDir(async () => {
      const now = Date.now();
      configureTaskRegistryRuntime({
        store: createInMemoryTaskRegistryStore({
          tasks: new Map([
            [
              "task-missing-cleanup",
              {
                taskId: "task-missing-cleanup",
                runtime: "cli",
                requesterSessionKey: "",
                ownerKey: "system:cli:task-missing-cleanup",
                scopeKind: "system",
                runId: "run-maintenance-cleanup",
                task: "Finished CLI task",
                status: "failed",
                deliveryStatus: "not_applicable",
                notifyPolicy: "silent",
                createdAt: now - 120_000,
                endedAt: now - 60_000,
                lastEventAt: now - 60_000,
              },
            ],
          ]),
          deliveryStates: new Map(),
        }),
      });

      expect(previewTaskRegistryMaintenance()).toEqual({
        reconciled: 0,
        recovered: 0,
        cleanupStamped: 1,
        pruned: 0,
      });

      expect(await runTaskRegistryMaintenance()).toEqual({
        reconciled: 0,
        recovered: 0,
        cleanupStamped: 1,
        pruned: 0,
      });
      expect(getTaskById("task-missing-cleanup")?.cleanupAfter).toBeGreaterThan(now);
    });
  });
}
