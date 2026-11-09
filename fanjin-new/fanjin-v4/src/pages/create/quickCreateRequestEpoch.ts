export type QuickCreateProjectRequestScope = {
  requestEpoch: number;
  projectEpoch: number;
  projectId: number | null;
};

/**
 * Shared invalidation clock for every paid/generation request on Quick Create.
 * A project change invalidates both project- and request-scoped responses;
 * ordinary resets only invalidate the active request.
 */
export class QuickCreateProjectRequestEpoch {
  private requestEpoch = 0;
  private projectEpoch = 0;

  begin(projectId: number | null): QuickCreateProjectRequestScope {
    this.requestEpoch += 1;
    return {
      requestEpoch: this.requestEpoch,
      projectEpoch: this.projectEpoch,
      projectId,
    };
  }

  invalidateRequest() {
    this.requestEpoch += 1;
  }

  projectChanged() {
    this.projectEpoch += 1;
    this.requestEpoch += 1;
  }

  isCurrent(scope: QuickCreateProjectRequestScope, projectId: number | null) {
    return scope.requestEpoch === this.requestEpoch
      && scope.projectEpoch === this.projectEpoch
      && scope.projectId === projectId;
  }

  /** Adopt the one controlled project switch performed by materialization. */
  adoptInternalProjectSwitch(
    scope: QuickCreateProjectRequestScope,
    targetProjectId: number,
    currentProjectId: number | null,
  ) {
    const projectDelta = scope.projectId === targetProjectId ? 0 : 1;
    if (
      currentProjectId !== targetProjectId
      || this.projectEpoch !== scope.projectEpoch + projectDelta
      || this.requestEpoch !== scope.requestEpoch + projectDelta
    ) {
      return false;
    }
    scope.projectId = targetProjectId;
    scope.projectEpoch = this.projectEpoch;
    scope.requestEpoch = this.requestEpoch;
    return true;
  }
}
