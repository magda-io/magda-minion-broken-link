import URI from "urijs";

export default function parseUriSafe(url: string): URI | undefined {
    try {
        return new URI(url);
    } catch (e) {
        return undefined;
    }
}
