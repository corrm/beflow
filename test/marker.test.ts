import { describe, expect, it } from "bun:test";

import { BEFLOW_MARKER, hasMarker, stripMarker, withMarker } from "../src/trackers/marker.ts";

describe("BEFLOW_MARKER", () => {
    it("starts with two newlines and the em-dash text", () => {
        expect(BEFLOW_MARKER).toBe("\n\n— beflow");
    });
});

describe("hasMarker", () => {
    it("returns true for a body that contains the marker text", () => {
        expect(hasMarker("some text\n\n— beflow")).toBe(true);
    });

    it("returns false for a plain human body", () => {
        expect(hasMarker("just a normal comment")).toBe(false);
    });

    it("returns true when marker is embedded in HTML tags", () => {
        expect(hasMarker("<p>text</p><p>— beflow</p>")).toBe(true);
    });

    it("returns false for an empty string", () => {
        expect(hasMarker("")).toBe(false);
    });
});

describe("withMarker", () => {
    it("appends the marker to a plain body", () => {
        expect(withMarker("my comment")).toBe("my comment\n\n— beflow");
    });

    it("is idempotent: does not double-append if the marker is already present", () => {
        const once = withMarker("my comment");
        expect(withMarker(once)).toBe(once);
    });

    it("appends the marker to a multi-paragraph body", () => {
        expect(withMarker("para one\n\npara two")).toBe("para one\n\npara two\n\n— beflow");
    });
});

describe("stripMarker", () => {
    it("removes a trailing marker and returns the clean text", () => {
        expect(stripMarker("my comment\n\n— beflow")).toBe("my comment");
    });

    it("returns the body unchanged when no marker is present", () => {
        expect(stripMarker("human comment")).toBe("human comment");
    });

    it("strips trailing whitespace from a body with no marker", () => {
        expect(stripMarker("trailing spaces   ")).toBe("trailing spaces");
    });

    it("roundtrips: stripMarker(withMarker(body)) === body.trimEnd()", () => {
        const body = "first para\n\nsecond para";
        expect(stripMarker(withMarker(body))).toBe(body);
    });

    it("handles the marker embedded in multi-paragraph text", () => {
        expect(stripMarker("para one\n\npara two\n\n— beflow")).toBe("para one\n\npara two");
    });
});
