import { parse } from 'txml/txml';

const XML_PARSE_OPTIONS = {
  decodeEntities: true,
  selfClosingTags: [],
  simplify: true,
};

/** Parses a YouTube Atom feed into txml's simplified object form for schema validation. */
export function parseYouTubeXml(xml: string): unknown {
  return parse(xml, XML_PARSE_OPTIONS);
}
