export const BEFLOW_MARKER = "\n\n— beflow";

export function withMarker(body: string): string {
    if (hasMarker(body)) {
        return body;
    }
    return body + BEFLOW_MARKER;
}

export function hasMarker(text: string): boolean {
    return text.includes("— beflow");
}

export function stripMarker(text: string): string {
    const idx = text.lastIndexOf("\n\n— beflow");
    if (idx === -1) {
        return text.trimEnd();
    }
    return text.slice(0, idx).trimEnd();
}
