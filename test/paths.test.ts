import { describe, expect, it } from 'vitest';
import { pchipEndpointSlope } from '../src/paths';

describe('pchipEndpointSlope', () => {
  it('reproduces a constant slope through the edge', () => {
    // Uniform spacing, constant secant ⇒ endpoint derivative equals it.
    expect(pchipEndpointSlope(1, 1, 1, 1)).toBeCloseTo(1, 12);
    expect(pchipEndpointSlope(1, 1, -2, -2)).toBeCloseTo(-2, 12);
  });

  it('reflects the curvature trend at the edge', () => {
    // Slope rising inward (sA<sB, same sign): the edge sits on the flatter part
    // of the rise, so the 3-point estimate bends the edge tangent BELOW the
    // boundary secant — curvature a flat boundary-secant tangent would miss.
    const d = pchipEndpointSlope(1, 1, 1, 2); // ((2+1)*1 - 1*2)/2 = 0.5
    expect(d).toBeCloseTo(0.5, 12);
    expect(d).toBeLessThan(1); // below the secant; no overshoot
  });

  it('clamps to zero when the estimate would reverse the secant', () => {
    // Steep inward secant flips the extrapolation sign ⇒ flatten to avoid a
    // fabricated bump at the edge.
    expect(pchipEndpointSlope(1, 1, 1, 5)).toBe(0); // ((3)*1 - 1*5)/2 = -1 → 0
  });

  it('caps at 3× the secant near a turning edge', () => {
    // Secants disagree in sign and the estimate exceeds the monotonicity bound.
    expect(pchipEndpointSlope(1, 1, 1, -5)).toBeCloseTo(3, 12); // d=4 → 3·sA
    expect(pchipEndpointSlope(1, 1, -1, 5)).toBeCloseTo(-3, 12); // mirror
  });
});
