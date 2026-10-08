export type DependencyReadiness = "ok" | "unavailable";

export interface ReadinessResponse {
  status: "ready" | "not_ready";
  dependencies: {
    postgres: DependencyReadiness;
    redis: DependencyReadiness;
  };
}

export interface ReadinessProbes {
  postgres: () => Promise<unknown>;
  redis: () => Promise<unknown>;
}

export const READINESS_PROBE_TIMEOUT_MS = 1_500;

/**
 * Run each dependency probe independently and bound its wait. In particular,
 * Redis clients configured for queue workloads may retry for a long time; a
 * readiness request must return promptly when the Redis control connection is
 * unavailable.
 */
export async function checkReadiness(
  probes: ReadinessProbes,
  timeoutMs = READINESS_PROBE_TIMEOUT_MS,
): Promise<ReadinessResponse> {
  const [postgres, redis] = await Promise.all([
    runProbe(probes.postgres, timeoutMs),
    runProbe(probes.redis, timeoutMs),
  ]);

  const ready = postgres === "ok" && redis === "ok";
  return {
    status: ready ? "ready" : "not_ready",
    dependencies: { postgres, redis },
  };
}

async function runProbe(
  probe: () => Promise<unknown>,
  timeoutMs: number,
): Promise<DependencyReadiness> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve("unavailable"), timeoutMs);
    timeout.unref?.();

    void Promise.resolve()
      .then(probe)
      .then(
        () => resolve("ok"),
        () => resolve("unavailable"),
      )
      .finally(() => clearTimeout(timeout));
  });
}
