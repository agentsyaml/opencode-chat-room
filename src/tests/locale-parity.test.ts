import { expect, test } from "bun:test";
import { messages, SUPPORTED_LOCALES } from "../../server/assets/chat/state.js";

test("every supported locale has the English key set", () => {
  const dictionaries = messages as unknown as Record<string, Record<string, unknown>>;
  const englishDictionary = dictionaries.en!;
  const english = Object.keys(englishDictionary).sort();
  expect(SUPPORTED_LOCALES.slice().sort()).toEqual(Object.keys(dictionaries).sort());
  for (const code of SUPPORTED_LOCALES) {
    const dictionary = dictionaries[code]!;
    expect(Object.keys(dictionary).sort()).toEqual(english);
    for (const key of english) expect(typeof dictionary[key]).toBe(typeof englishDictionary[key]);
  }
});