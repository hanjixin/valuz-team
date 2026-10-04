export function useResourceGuard(_resource: {
  source?: string;
  readonly?: boolean;
  deletable?: boolean;
}) {
  return {
    canEdit: _resource.readonly !== true,
    canDelete: _resource.deletable !== false,
  };
}
