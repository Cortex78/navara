import { describe, expect, it } from "vitest";

import { decodeBil32 } from "./bil";

const bil = (values: number[]) => {
  const view = new DataView(new ArrayBuffer(values.length * 4));
  values.forEach((v, i) => view.setFloat32(i * 4, v, true));
  return view.buffer;
};

describe("decodeBil32", () => {
  it("reads little-endian float32 and maps no-data, blended or not, to NaN", () => {
    const out = decodeBil32(
      bil([1.5, -9999, 2.25, -99999, -3.5, 4808.7]),
      3,
      2,
    );
    expect(out[0]).toBe(1.5);
    expect(out[1]).toBeNaN();
    expect(out[2]).toBe(2.25);
    expect(out[3]).toBeNaN();
    expect(out[4]).toBe(-3.5);
    expect(out[5]).toBeCloseTo(4808.7, 3);
  });

  it("rejects bodies of the wrong size (e.g. an XML error)", () => {
    expect(() => decodeBil32(new ArrayBuffer(388), 64, 64)).toThrow(
      /388 bytes/,
    );
  });
});
