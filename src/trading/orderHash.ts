// ORDER HASH — the venue's order id of a signed order, computed here before it is posted ("orderID: Order ID (order hash)",
// docs.polymarket.com/api-reference/trade/cancel-single-order). For a Deposit Wallet (signatureType 3, POLY_1271) the SDK signs
// a TypedDataSign wrapper, not the order, so the signer's payload is not the order's typed data; but it appends the order's
// EIP-712 domain separator and struct hash to the signature (@polymarket/client 0.6, `Hr`):
//   0x · ECDSA signature (65 bytes) · domain separator (32) · struct hash (32) · type string · its length (2)
// The order hash is then keccak256(0x1901 · domain separator · struct hash), the exchange's hashOrder. The struct hash is
// recomputed from the order's own fields as a check; a mismatch returns null.
// Checked on real 1¢ orders (latency/tools/orders.ts --mode idcancel, 2026-10-29): the venue's id in 16 of 16 accepted orders.
// Used by venue.ts so that LIVE_EARLY_CANCEL can cancel an order before its post is answered.
import { concatHex, encodeAbiParameters, keccak256, stringToHex, type Hex } from "viem";

const ORDER_TYPE = "Order(uint256 salt,address maker,address signer,uint256 tokenId,uint256 makerAmount,uint256 takerAmount,uint8 side,uint8 signatureType,uint256 timestamp,bytes32 metadata,bytes32 builder)";
const ZERO = `0x${"0".repeat(64)}` as Hex;

/** keccak256 of the order's EIP-712 struct, from its fields (the SDK's `Sm`). */
export function structHash(o: any): Hex {
  const side = o.side === 0 || o.side === 1 ? o.side : String(o.side).toUpperCase() === "BUY" ? 0 : 1;
  return keccak256(encodeAbiParameters(
    [{ type: "bytes32" }, { type: "uint256" }, { type: "address" }, { type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" },
      { type: "uint8" }, { type: "uint8" }, { type: "uint256" }, { type: "bytes32" }, { type: "bytes32" }],
    [keccak256(stringToHex(ORDER_TYPE)), BigInt(o.salt), o.maker, o.signer, BigInt(o.tokenId), BigInt(o.makerAmount), BigInt(o.takerAmount),
      side, Number(o.signatureType), BigInt(o.timestamp), (o.metadata ?? ZERO) as Hex, (o.builder ?? ZERO) as Hex]));
}

/** The order id the venue will give this signed order, or null when the signature does not carry the order's hashes
 *  (not a POLY_1271 order) or its struct hash disagrees with the order's fields. */
export function orderId(o: any): Hex | null {
  const sig = String(o?.signature ?? "");
  if (!/^0x[0-9a-fA-F]+$/.test(sig) || sig.length < 2 + 130 + 128) return null;
  const domain = `0x${sig.slice(132, 196)}` as Hex, struct = `0x${sig.slice(196, 260)}` as Hex;
  if (struct.toLowerCase() !== structHash(o).toLowerCase()) return null;
  return keccak256(concatHex(["0x1901", domain, struct]));
}
