export function buildSubmitButtonPendingKey(action: string, nodeId: string) {
  return `${action}\u0000${nodeId}`;
}

export function isSubmitButtonPendingKeyForNode(key: string, nodeId: string) {
  return key.endsWith(`\u0000${nodeId}`);
}
