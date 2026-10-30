# Writing a Gatestormers chapter

Every chapter is one HTML file in this folder (`chapter-01.html`, `chapter-02.html`, …).
To start a new one, copy `chapter-01.html`, then swap out the prose and the roll cards.
Add the chapter to the list in `index.html` too.

## 1. Mark the passage

Wrap the sentence (or phrase) that the roll decided:

```html
<span class="roll" data-roll="read-the-ward">She followed the lines inward…</span>
```

`data-roll` is an id. Use lowercase words joined by hyphens, and make each one
unique within the chapter. The id also works as a link: `chapter-01.html#read-the-ward`
opens the chapter at that roll with the card already showing.

You can mark more than one passage with the same id if a single roll plays out over several places.

## 2. Write the roll card

Inside the `roll-ledger` section at the bottom, add one `<aside>` per roll:

```html
<aside class="roll-card" id="jasa-arrives"
       data-check="Wisdom (Perception) Check" data-die="d20"
       data-natural="7" data-dc="12">
    <h3>Does David notice Jasa?</h3>
    <p class="roll-summary">Wisdom (Perception) Check, d20, DC 12: 7. Failure.</p>
</aside>
```

The reader sees:

- the check and die (`WISDOM (PERCEPTION) CHECK · D20`)
- the DC on the die icon (`12`)
- your question as the headline
- **What happened:** `7. Failure.` This is worked out from the numbers, so you never type it.

With a modifier it reads `7 + 3 = 10. Failure.` On a d20, a natural 20 or 1 reads
"Critical success" or "Critical failure" whatever the total. With no DC (a random
table roll), the die shows the roll itself and there is no Success/Failure.

### Author's note (only when you have one)

```html
    <div class="author-note">
        <h4>Author's note</h4>
        <p>…</p>
    </div>
```

Leave it out entirely when there's nothing to say.

### Attributes

| Attribute      | Required | Meaning |
|----------------|----------|---------|
| `id`           | yes      | Same as the passage's `data-roll`. |
| `data-check`   | yes      | "Wisdom (Perception) Check", "Attack Roll", "Random Event"… |
| `data-die`     | no       | `d20` (default), `d6`, `2d6`, `d100`… |
| `data-natural` | yes      | What the dice actually showed. For several dice, give the sum. |
| `data-dice`    | no       | The individual dice for a multi-die roll, e.g. `data-dice="3 6"`. |
| `data-mod`     | no       | Modifier added to the natural roll (`5`, `-1`). |
| `data-dc`      | no       | Target number. Leave it out for random table rolls. |
| `data-vs`      | no       | What the target is called: `DC` (default) or `AC`. |

### Typical DCs

| Task | DC |
|---|---|
| Very easy | 5 |
| Easy | 10 |
| Medium | 15 |
| Hard | 20 |
| Very hard | 25 |
| Nearly impossible | 30 |

`.roll-summary` is the plain-text line shown to readers without JavaScript. Keep it in sync.

## Licensing

The landing page carries the SRD 5.2 attribution that CC-BY-4.0 requires. If you work
from SRD 5.1 (the 2014 rules) instead, change the attribution to 5.1's wording. Only use
creatures, spells and rules that appear in the SRD. Settings, named characters and product
identity such as beholders and mind flayers are not in it.
