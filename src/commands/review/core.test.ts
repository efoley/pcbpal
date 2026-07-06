import { describe, expect, test } from "bun:test";
import type { Netlist, NetlistNet, NetlistNode } from "../../services/netlist.js";
import { buildNetsDigest } from "./core.js";

// ── fixtures ──

function node(ref: string, pin: string, pinFunction = ""): NetlistNode {
  return { ref, pin, pinFunction, pinType: "passive" };
}

function net(code: number, name: string, nodes: NetlistNode[]): NetlistNet {
  return { code, name, nodes };
}

function netlist(nets: NetlistNet[]): Netlist {
  return { sheets: [], components: [], nets };
}

describe("buildNetsDigest", () => {
  test("formats pins as REF.pin when no pin function is present", () => {
    const nl = netlist([net(1, "GND", [node("C1", "2"), node("U1", "23")])]);

    const digest = buildNetsDigest(nl);

    expect(digest).toEqual([{ name: "GND", pins: ["C1.2", "U1.23"] }]);
  });

  test("appends the pin function in parens when the netlist provides one", () => {
    const nl = netlist([
      net(3, "NRST", [node("U2", "7", "NRST"), node("SW1", "1"), node("J1", "3", "RESET")]),
    ]);

    const digest = buildNetsDigest(nl);

    expect(digest).toEqual([{ name: "NRST", pins: ["J1.3(RESET)", "SW1.1", "U2.7(NRST)"] }]);
  });

  test("sorts nets by name and pins within a net lexically", () => {
    const nl = netlist([
      net(2, "VCC", [node("R1", "1"), node("U1", "1")]),
      net(1, "GND", [node("U1", "23"), node("C2", "2"), node("C1", "2")]),
    ]);

    const digest = buildNetsDigest(nl);

    expect(digest.map((n) => n.name)).toEqual(["GND", "VCC"]);
    expect(digest[0].pins).toEqual(["C1.2", "C2.2", "U1.23"]);
    expect(digest[1].pins).toEqual(["R1.1", "U1.1"]);
  });

  test("returns an empty array for a netlist with no nets", () => {
    expect(buildNetsDigest(netlist([]))).toEqual([]);
  });
});
