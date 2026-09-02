export function isReadablePdfText(value: string): boolean {
  if (value.length < 20) return false;
  const characters = [...value];
  const controls = characters.filter((character) => {
    const code = character.codePointAt(0) ?? 0;
    return (code < 32 && character !== "\n" && character !== "\t") ||
      (code >= 127 && code <= 159);
  }).length;
  if (controls / characters.length > 0.005) return false;

  const readable =
    characters.filter((character) =>
      /[A-Za-zÀ-ÖØ-öø-ÿ0-9\s.,;:!?()[\]{}%/\\+\-_=€$@#"'`~|<>]/u.test(
        character,
      )
    ).length;
  const words = value.match(/[A-Za-zÀ-ÖØ-öø-ÿ]{2,}/g)?.length ?? 0;
  return readable / characters.length >= 0.85 && words >= 3;
}
