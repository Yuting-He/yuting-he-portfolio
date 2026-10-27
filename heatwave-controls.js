// Search and navigation helpers keep DOM interaction separate from risk rules.
const aliases = { munchen: "munich", koln: "cologne", nurnberg: "nuremberg", bayern: "bavaria" };
export function normalizeLocation(value) {
  return String(value || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replaceAll("ß", "ss").replace(/ae/g, "a").replace(/oe/g, "o").replace(/ue/g, "u").trim();
}
export function searchLocations(items, query, limit = 12) {
  const term = normalizeLocation(query);
  if (!term) return [];
  return items.map((item) => {
    const name = normalizeLocation(item.name);
    const alias = aliases[name.split(",")[0]] || "";
    const haystack = `${name} ${alias} ${normalizeLocation(item.stateName)} ${item.id.toLowerCase()}`;
    const position = haystack.indexOf(term);
    const rank = name === term ? 0 : name.startsWith(term) ? 1 : alias.startsWith(term) && alias ? 2 : position >= 0 ? 3 : 9;
    return { item, rank };
  }).filter(({ rank }) => rank < 9)
    .sort((a, b) => a.rank - b.rank || a.item.name.localeCompare(b.item.name, "de"))
    .slice(0, limit).map(({ item }) => item);
}

export function installLocationSearch({ input, list, status, getItems, label, onSelect }) {
  let items = [], active = -1;
  const close = () => {
    list.hidden = true;
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
    active = -1;
  };
  const highlight = () => {
    [...list.children].forEach((node, index) => node.setAttribute("aria-selected", String(index === active)));
    if (active >= 0) input.setAttribute("aria-activedescendant", list.children[active].id);
    else input.removeAttribute("aria-activedescendant");
  };
  const choose = (index) => {
    const item = items[index];
    if (!item) return;
    input.value = item.name;
    close();
    onSelect(item);
  };
  const refresh = () => {
    items = searchLocations(getItems(), input.value);
    active = -1;
    list.replaceChildren(...items.map((item, index) => {
      const option = document.createElement("li");
      option.id = `location-option-${index}`;
      option.setAttribute("role", "option");
      option.setAttribute("aria-selected", "false");
      option.textContent = label(item);
      option.addEventListener("pointerdown", (event) => event.preventDefault());
      option.addEventListener("click", () => choose(index));
      return option;
    }));
    list.hidden = !input.value.trim() || !items.length;
    input.setAttribute("aria-expanded", String(!list.hidden));
    input.removeAttribute("aria-activedescendant");
    status.textContent = !input.value.trim() ? "" : label(null, items.length);
  };
  input.addEventListener("input", refresh);
  input.addEventListener("focus", () => { if (input.value) refresh(); });
  input.addEventListener("blur", close);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Escape") { close(); return; }
    if (["ArrowDown", "ArrowUp"].includes(event.key)) {
      event.preventDefault();
      if (list.hidden) refresh();
      if (!items.length) return;
      list.hidden = false;
      input.setAttribute("aria-expanded", "true");
      active = event.key === "ArrowDown" ? (active + 1) % items.length : (active <= 0 ? items.length - 1 : active - 1);
      highlight();
    } else if (event.key === "Enter" && !list.hidden && items.length) {
      event.preventDefault();
      choose(active >= 0 ? active : 0);
    }
  });
  return { close, refresh };
}
