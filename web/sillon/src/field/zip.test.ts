import { describe, expect, it } from "vitest";

import { unzip, zipStore } from "./zip";

describe("zip", () => {
  it("round-trips stored entries with UTF-8 names", async () => {
    const a = new TextEncoder().encode("Pré du Mas");
    const b = Uint8Array.from({ length: 3000 }, (_, i) => i & 0xff);
    const files = await unzip(
      zipStore([
        { name: "champ é.txt", data: a },
        { name: "bytes.bin", data: b },
      ]),
    );
    expect([...files.keys()]).toEqual(["champ é.txt", "bytes.bin"]);
    expect(new TextDecoder().decode(files.get("champ é.txt"))).toBe(
      "Pré du Mas",
    );
    expect(files.get("bytes.bin")).toEqual(b);
  });

  it("refuses something that is not a zip", async () => {
    await expect(unzip(new Uint8Array(100))).rejects.toThrow(/not a zip/);
  });
});
