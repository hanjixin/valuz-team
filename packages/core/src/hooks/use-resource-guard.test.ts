import { describe, expect, it } from "vitest";

import { useResourceGuard } from "./use-resource-guard";

describe("useResourceGuard", () => {
  it("allows ordinary resources by default", () => {
    expect(useResourceGuard({})).toEqual({
      canEdit: true,
      canDelete: true,
    });
  });

  it("respects readonly and deletable flags", () => {
    expect(
      useResourceGuard({
        readonly: true,
        deletable: false,
      }),
    ).toEqual({
      canEdit: false,
      canDelete: false,
    });
  });
});
