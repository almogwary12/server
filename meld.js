const Suit = Object.freeze({ HEARTS: 0, DIAMONDS: 1, CLUBS: 2, SPADES: 3 });

// FIX: Ace = 15 (matches the Dart client's CardModel.value and
// CardModel.valueForRank). The previous 10 caused the server to compute
// a meld's value as lower than the client, so a meld the client thought
// was worth 51 was rejected server-side as "Incomplete meld".
function valueForRank(rank) {
    if (rank === 0) return 0;
    if (rank === 1) return 15;
    if (rank === 14) return 15;
    if (rank >= 11) return 10;
    return rank;
}

function hasDuplicates(cards) {
    for (let i = 0; i < cards.length; i++) {
        if (cards[i].joker) continue;
        for (let j = i + 1; j < cards.length; j++) {
            if (cards[j].joker) continue;
            const a = cards[i], b = cards[j];
            if (a.rank === b.rank && a.suit === b.suit) return true;
        }
    }
    return false;
}

function fitsConsecutive(ranks, jokers) {
    for (let i = 1; i < ranks.length; i++) {
        if (ranks[i] === ranks[i - 1]) return false;
    }
    let j = jokers;
    for (let i = 1; i < ranks.length; i++) {
        const gap = ranks[i] - ranks[i - 1] - 1;
        if (gap > 0) { j -= gap; if (j < 0) return false; }
    }
    return true;
}

function isValidSet(cards) {
    if (cards.length < 3 || cards.length > 4) return false;
    const nj = cards.filter((c) => !c.joker);
    if (nj.length === 0) return false;
    const r = nj[0].rank;
    return nj.every((c) => c.rank === r);
}

function isValidRun(cards) {
    if (cards.length < 3) return false;
    const nj = cards.filter((c) => !c.joker);
    if (nj.length < 2) return false;
    const s = nj[0].suit;
    if (!nj.every((c) => c.suit === s)) return false;
    const jokers = cards.filter((c) => c.joker).length;
    const low = nj.map((c) => (c.rank === 1 ? 1 : c.rank)).sort((a, b) => a - b);
    if (fitsConsecutive(low, jokers)) return true;
    const high = nj.map((c) => (c.rank === 1 ? 14 : c.rank)).sort((a, b) => a - b);
    if (fitsConsecutive(high, jokers)) return true;
    return false;
}

function isRed(suit) { return suit === Suit.HEARTS || suit === Suit.DIAMONDS; }

class Meld {
    constructor(cards, type, { owner = 0, jokerRanks = {}, jokerSuits = {} } = {}) {
        this.cards = [...cards];
        this.type = type;
        this.owner = owner;
        this.jokerRanks = { ...jokerRanks };
        this.jokerSuits = { ...jokerSuits };
        this.lockedValue = null;
        this.hasJoker = cards.some((c) => c.joker);
        this.sortCards();
        this.inferJokerSuitsForSets();
    }

    static tryCreate(cards, { owner = 0, jokerRanks, jokerSuits } = {}) {
        if (hasDuplicates(cards)) return null;
        if (isValidSet(cards))
            return new Meld(cards, 'set', { owner, jokerRanks, jokerSuits });
        if (isValidRun(cards))
            return new Meld(cards, 'run', { owner, jokerRanks, jokerSuits });
        return null;
    }

    inferJokerSuitsForSets() {
        if (this.type !== 'set') return;
        for (let i = 0; i < this.cards.length; i++) {
            if (!this.cards[i].joker) continue;
            if (this.jokerSuits[i] != null) continue;
            if (this.jokerRanks[i] == null) continue;
            const used = new Set();
            for (const c of this.cards) {
                if (!c.joker && c.suit != null) used.add(c.suit);
            }
            for (let k = 0; k < this.cards.length; k++) {
                if (k !== i && this.cards[k].joker && this.jokerSuits[k] != null) {
                    used.add(this.jokerSuits[k]);
                }
            }
            const missing = [0, 1, 2, 3].filter((s) => !used.has(s));
            if (missing.length > 0) this.jokerSuits[i] = missing[0];
        }
    }

    get totalValue() {
        if (this.type === 'set') {
            let sum = 0;
            let setRank = null;
            for (const c of this.cards) {
                if (!c.joker) { setRank = c.rank; break; }
            }
            if (setRank == null) setRank = 13;
            for (let i = 0; i < this.cards.length; i++) {
                const c = this.cards[i];
                if (c.joker) {
                    const rank = this.jokerRanks[i] ?? setRank;
                    sum += valueForRank(rank);
                } else {
                    sum += valueForRank(c.rank);
                }
            }
            return sum;
        }
        const ranks = this.effectiveRanks();
        const hasLowAce = ranks.some((r) => r === 1);
        const lowAceDiscount = hasLowAce && this.cards.length >= 5;
        let sum = 0;
        for (const r of ranks) {
            if (r === 1 && lowAceDiscount) {
                sum += 1;
            } else {
                sum += valueForRank(r);
            }
        }
        return sum;
    }

    lockValue() { if (this.lockedValue == null) this.lockedValue = this.totalValue; }

    aceShouldBeHigh() {
        for (const c of this.cards) {
            if (c.joker) continue;
            if (c.rank >= 11) return true;
        }
        return false;
    }

    effectiveRanks() {
        const aceHigh = this.aceShouldBeHigh();
        const out = [];
        for (let i = 0; i < this.cards.length; i++) {
            const c = this.cards[i];
            if (c.joker) out.push(this.jokerRanks[i] ?? 100);
            else if (c.rank === 1 && aceHigh) out.push(14);
            else out.push(c.rank);
        }
        return out;
    }

    sortCards() {
        if (this.type === 'set') return;
        if (this.cards.length <= 1) return;
        const effective = this.effectiveRanks();
        const entries = this.cards.map((_, i) => [i, effective[i]]);
        entries.sort((a, b) => a[1] - b[1]);
        const newCards = [];
        const newRanks = {};
        const newSuits = {};
        for (let i = 0; i < entries.length; i++) {
            const [oldIdx] = entries[i];
            newCards.push(this.cards[oldIdx]);
            if (this.jokerRanks[oldIdx] != null) newRanks[i] = this.jokerRanks[oldIdx];
            if (this.jokerSuits[oldIdx] != null) newSuits[i] = this.jokerSuits[oldIdx];
        }
        this.cards = newCards;
        this.jokerRanks = newRanks;
        this.jokerSuits = newSuits;
    }

    hasCard(card) {
        if (!card) return false;
        if (card.joker) return false;
        return this.cards.some((c) => !c.joker && c.rank === card.rank && c.suit === card.suit);
    }

    canLayoff(card) {
        if (!card || card.joker) return false;
        if (this.hasCard(card)) return false;
        if (this.type === 'set') {
            const nj = this.cards.filter((c) => !c.joker);
            if (nj.length === 0) return false;
            if (nj[0].rank !== card.rank) return false;
            if (this.cards.length >= 4) return false;
            for (const c of nj) { if (c.suit === card.suit) return false; }
            for (let i = 0; i < this.cards.length; i++) {
                if (!this.cards[i].joker) continue;
                if (this.jokerRanks[i] !== card.rank) continue;
                if (this.jokerSuits[i] === card.suit) return false;
            }
            return true;
        }
        const nj = this.cards.filter((c) => !c.joker);
        if (nj.length === 0) return false;
        if (card.suit !== nj[0].suit) return false;
        const ranks = this.effectiveRanks().filter((r) => r < 100).sort((a, b) => a - b);
        if (ranks.length === 0) return false;
        const minR = ranks[0], maxR = ranks[ranks.length - 1];
        if (card.rank === maxR + 1) return true;
        if (card.rank === minR - 1) return true;
        if (card.rank === 1 && maxR === 13) return true;
        return false;
    }

    addCard(card) {
        if (card.joker) this.hasJoker = true;
        this.cards.push(card);
        this.lockedValue = null;
        this.sortCards();
        this.inferJokerSuitsForSets();
    }

    jokerIndexReplaceableBy(card) {
        if (!card || card.joker) return null;
        for (let i = 0; i < this.cards.length; i++) {
            const c = this.cards[i];
            if (!c.joker) continue;
            const effective = this.jokerRanks[i];
            if (effective == null) continue;
            const rankMatches =
                effective === card.rank ||
                (effective === 14 && card.rank === 1) ||
                (effective === 1 && card.rank === 14);
            if (!rankMatches) continue;
            let duplicate = false;
            for (let j = 0; j < this.cards.length; j++) {
                if (j === i) continue;
                const cc = this.cards[j];
                if (!cc.joker && cc.rank === card.rank && cc.suit === card.suit) {
                    duplicate = true; break;
                }
            }
            if (duplicate) continue;
            if (this.type === 'set') {
                const js = this.jokerSuits[i];
                if (js == null) continue;
                if (js !== card.suit) continue;
            } else {
                let suit;
                for (const cc of this.cards) {
                    if (!cc.joker) { suit = cc.suit; break; }
                }
                if (suit != null && card.suit !== suit) continue;
            }
            return i;
        }
        return null;
    }

    replaceJokerAt(index, realCard) {
        if (index < 0 || index >= this.cards.length) return;
        if (!this.cards[index].joker) return;
        this.cards[index] = realCard;
        delete this.jokerRanks[index];
        delete this.jokerSuits[index];
        this.hasJoker = this.cards.some((c) => c.joker);
        this.lockedValue = null;
        this.sortCards();
        this.inferJokerSuitsForSets();
    }

    addJokerCard(joker, effectiveRank, suit) {
        this.cards.push(joker);
        const newIdx = this.cards.length - 1;
        this.jokerRanks[newIdx] = effectiveRank;
        if (suit != null) this.jokerSuits[newIdx] = suit;
        this.hasJoker = true;
        this.lockedValue = null;
        this.sortCards();
        this.inferJokerSuitsForSets();
    }

    toJson() {
        return {
            cards: this.cards, type: this.type, owner: this.owner,
            hasJoker: this.hasJoker, jokerRanks: this.jokerRanks,
            jokerSuits: this.jokerSuits,
            lockedValue: this.lockedValue ?? this.totalValue,
        };
    }
}

module.exports = {
    Suit, Meld, valueForRank, hasDuplicates, isValidSet, isValidRun,
};