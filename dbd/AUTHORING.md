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
<aside class="roll-card" id="read-the-ward"
       data-check="Intelligence (Arcana)" data-die="d20"
       data-natural="12" data-mod="5" data-dc="15">
    <h3>Can Ilsa read the ward before it reads her?</h3>
    <p class="roll-summary">Intelligence (Arcana), d20: 12 + 5 = 17 vs DC 15</p>

    <h4>What was at stake</h4>
    <ol class="stakes">
        <li data-range="nat1">Worst case…</li>
        <li data-range="1-9">Failure…</li>
        <li data-range="10-14">Partial…</li>
        <li data-range="15+">Success…</li>
    </ol>

    <h4>What happened</h4>
    <p>…</p>

    <h4>What it changes</h4>
    <p>…</p>

    <div class="author-note">
        <h4>Author's note</h4>
        <p>…</p>
    </div>
</aside>
```

### Attributes

| Attribute      | Required | Meaning |
|----------------|----------|---------|
| `id`           | yes      | Same as the passage's `data-roll`. |
| `data-check`   | yes      | Label shown above the die: "Dexterity save", "Attack roll", "Random event"… |
| `data-die`     | no       | `d20` (default), `d6`, `2d6`, `d100`… |
| `data-natural` | yes      | What the dice actually showed. For several dice, give the sum. |
| `data-dice`    | no       | The individual dice for a multi-die roll, e.g. `data-dice="3 6"`. |
| `data-mod`     | no       | Modifier added to the natural roll (`5`, `-1`). |
| `data-dc`      | no       | Target number. Leave it out for rolls on a random table. |
| `data-vs`      | no       | What the target is called: `DC` (default) or `AC`. |

With a DC, the reader sees **Success** or **Failure**. On a d20, a natural 20 or 1
shows as a crit or fumble, whatever the total came to.

### Stakes

Each `<li>` in `.stakes` has a `data-range`, and the matching line gets highlighted:

- `7` is one exact total
- `10-14` is a range of totals (modifier included)
- `15+` means 15 or higher
- `nat1` / `nat20` match the natural die face and beat any range

Every section except the `<h3>` is optional. Leave out the author's note when you have nothing to say.

`.roll-summary` is a plain-text line for readers without JavaScript. The script
hides it and draws the die instead. Keep it in sync with the data attributes.

## Licensing

The landing page carries the SRD 5.2 attribution that CC-BY-4.0 requires. If you work
from SRD 5.1 (the 2014 rules) instead, change the attribution to 5.1's wording. Only use
creatures, spells and rules that appear in the SRD. Settings, named characters and product
identity such as beholders and mind flayers are not in it.
