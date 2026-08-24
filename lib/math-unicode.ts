/**
 * Best-effort LaTeX → Unicode conversion for terminal display.
 *
 * Converts the math segments of a markdown string ($...$ and $$...$$) into
 * Unicode approximations (x^2 → x², \alpha → α, \partial → ∂). Output is
 * wrapped in inline code / code fences so leftover LaTeX characters like
 * `_` and `*` can't be mangled by the markdown renderer. Display-only:
 * the original markdown (and the lesson log on disk) keeps raw LaTeX.
 */

const COMMANDS: Record<string, string> = {
	// Greek
	alpha: "α",
	beta: "β",
	gamma: "γ",
	delta: "δ",
	epsilon: "ε",
	varepsilon: "ε",
	zeta: "ζ",
	eta: "η",
	theta: "θ",
	vartheta: "ϑ",
	iota: "ι",
	kappa: "κ",
	lambda: "λ",
	mu: "μ",
	nu: "ν",
	xi: "ξ",
	pi: "π",
	rho: "ρ",
	sigma: "σ",
	tau: "τ",
	upsilon: "υ",
	phi: "φ",
	varphi: "φ",
	chi: "χ",
	psi: "ψ",
	omega: "ω",
	Gamma: "Γ",
	Delta: "Δ",
	Theta: "Θ",
	Lambda: "Λ",
	Xi: "Ξ",
	Pi: "Π",
	Sigma: "Σ",
	Upsilon: "Υ",
	Phi: "Φ",
	Psi: "Ψ",
	Omega: "Ω",
	// Operators & calculus
	partial: "∂",
	nabla: "∇",
	int: "∫",
	iint: "∬",
	iiint: "∭",
	oint: "∮",
	oiint: "∯",
	sum: "∑",
	prod: "∏",
	sqrt: "√",
	infty: "∞",
	pm: "±",
	mp: "∓",
	cdot: "·",
	times: "×",
	div: "÷",
	ast: "∗",
	circ: "∘",
	oplus: "⊕",
	otimes: "⊗",
	wedge: "∧",
	vee: "∨",
	star: "⋆",
	// Relations
	leq: "≤",
	le: "≤",
	geq: "≥",
	ge: "≥",
	neq: "≠",
	ne: "≠",
	approx: "≈",
	sim: "∼",
	simeq: "≃",
	cong: "≅",
	equiv: "≡",
	propto: "∝",
	perp: "⊥",
	parallel: "∥",
	mid: "∣",
	// Sets & logic
	in: "∈",
	notin: "∉",
	ni: "∋",
	subset: "⊂",
	supset: "⊃",
	subseteq: "⊆",
	supseteq: "⊇",
	cup: "∪",
	cap: "∩",
	setminus: "∖",
	emptyset: "∅",
	varnothing: "∅",
	forall: "∀",
	exists: "∃",
	nexists: "∄",
	neg: "¬",
	lnot: "¬",
	land: "∧",
	lor: "∨",
	implies: "⟹",
	iff: "⟺",
	// Arrows
	to: "→",
	rightarrow: "→",
	leftarrow: "←",
	leftrightarrow: "↔",
	Rightarrow: "⇒",
	Leftarrow: "⇐",
	Leftrightarrow: "⇔",
	mapsto: "↦",
	longrightarrow: "⟶",
	longmapsto: "⟼",
	uparrow: "↑",
	downarrow: "↓",
	// Dots & misc
	ldots: "…",
	cdots: "⋯",
	vdots: "⋮",
	ddots: "⋱",
	dots: "…",
	prime: "′",
	hbar: "ℏ",
	ell: "ℓ",
	Re: "ℜ",
	Im: "ℑ",
	aleph: "ℵ",
	angle: "∠",
	triangle: "△",
	square: "□",
	langle: "⟨",
	rangle: "⟩",
	lceil: "⌈",
	rceil: "⌉",
	lfloor: "⌊",
	rfloor: "⌋",
	dagger: "†",
	degree: "°",
	// Function names render as plain words
	liminf: "lim inf",
	limsup: "lim sup",
	lim: "lim",
	sin: "sin",
	cos: "cos",
	tan: "tan",
	sec: "sec",
	csc: "csc",
	cot: "cot",
	sinh: "sinh",
	cosh: "cosh",
	tanh: "tanh",
	arcsin: "arcsin",
	arccos: "arccos",
	arctan: "arctan",
	log: "log",
	ln: "ln",
	exp: "exp",
	min: "min",
	max: "max",
	sup: "sup",
	inf: "inf",
	det: "det",
	gcd: "gcd",
	deg: "deg",
	arg: "arg",
	dim: "dim",
	ker: "ker",
	bmod: "mod",
	pmod: "mod",
};

const MATHBB: Record<string, string> = {
	R: "ℝ",
	C: "ℂ",
	N: "ℕ",
	Z: "ℤ",
	Q: "ℚ",
	H: "ℍ",
	P: "ℙ",
	E: "𝔼",
	F: "𝔽",
};

const SUPERSCRIPTS: Record<string, string> = {
	"0": "⁰",
	"1": "¹",
	"2": "²",
	"3": "³",
	"4": "⁴",
	"5": "⁵",
	"6": "⁶",
	"7": "⁷",
	"8": "⁸",
	"9": "⁹",
	"+": "⁺",
	"-": "⁻",
	"(": "⁽",
	")": "⁾",
	"=": "⁼",
	a: "ᵃ",
	b: "ᵇ",
	c: "ᶜ",
	d: "ᵈ",
	e: "ᵉ",
	f: "ᶠ",
	g: "ᵍ",
	h: "ʰ",
	i: "ⁱ",
	j: "ʲ",
	k: "ᵏ",
	l: "ˡ",
	m: "ᵐ",
	n: "ⁿ",
	o: "ᵒ",
	p: "ᵖ",
	r: "ʳ",
	s: "ˢ",
	t: "ᵗ",
	u: "ᵘ",
	v: "ᵛ",
	w: "ʷ",
	x: "ˣ",
	y: "ʸ",
	z: "ᶻ",
	T: "ᵀ",
};

const SUBSCRIPTS: Record<string, string> = {
	"0": "₀",
	"1": "₁",
	"2": "₂",
	"3": "₃",
	"4": "₄",
	"5": "₅",
	"6": "₆",
	"7": "₇",
	"8": "₈",
	"9": "₉",
	"+": "₊",
	"-": "₋",
	"(": "₍",
	")": "₎",
	"=": "₌",
	a: "ₐ",
	e: "ₑ",
	h: "ₕ",
	i: "ᵢ",
	j: "ⱼ",
	k: "ₖ",
	l: "ₗ",
	m: "ₘ",
	n: "ₙ",
	o: "ₒ",
	p: "ₚ",
	r: "ᵣ",
	s: "ₛ",
	t: "ₜ",
	u: "ᵤ",
	v: "ᵥ",
	x: "ₓ",
};

/** Read a brace-balanced group starting at `{`; returns [contents, indexAfterClosingBrace]. */
function readGroup(s: string, start: number): [string, number] {
	if (s[start] !== "{") {
		// Single-token argument: one char or one \command
		if (s[start] === "\\") {
			const m = /^\\[a-zA-Z]+/.exec(s.slice(start));
			if (m) return [m[0], start + m[0].length];
		}
		return [s[start] ?? "", start + 1];
	}
	let depth = 0;
	for (let i = start; i < s.length; i++) {
		if (s[i] === "{") depth++;
		else if (s[i] === "}") {
			depth--;
			if (depth === 0) return [s.slice(start + 1, i), i + 1];
		}
	}
	return [s.slice(start + 1), s.length];
}

function mapChars(s: string, table: Record<string, string>): string | null {
	let out = "";
	for (const ch of s) {
		const mapped = table[ch];
		if (mapped === undefined) return null;
		out += mapped;
	}
	return out;
}

/** True when the expression is a single visual token (no spaces or operators). */
function isSimpleToken(s: string): boolean {
	return /^[^\s+\-*/=<>]{1,4}$/.test(s);
}

export function convertMathExpression(input: string): string {
	let s = input;

	// Spacing and structural commands
	s = s.replace(/\\(?:display|text|script|scriptscript)style\s*/g, "");
	s = s.replace(/\\left|\\right|\\!|\\,|\\;|\\:/g, "");
	s = s.replace(/\\quad|\\qquad/g, "  ");
	s = s.replace(/\\\\/g, "\n");

	// \text{...}, \mathrm{...}, \operatorname{...} → contents
	s = s.replace(/\\(?:text|mathrm|mathit|operatorname)\s*\{([^{}]*)\}/g, "$1");

	// \mathbb{X}
	s = s.replace(/\\mathbb\s*\{([A-Z])\}/g, (_, ch) => MATHBB[ch] ?? ch);

	// \frac{a}{b} — innermost first so nested fractions resolve
	const fracRe = /\\[dt]?frac\s*(?=\{)/;
	for (let guard = 0; guard < 20; guard++) {
		const m = fracRe.exec(s);
		if (!m) break;
		const [num, afterNum] = readGroup(s, m.index + m[0].length);
		const [den, afterDen] = readGroup(s, afterNum);
		const numC = convertMathExpression(num);
		const denC = convertMathExpression(den);
		const rendered =
			isSimpleToken(numC) && isSimpleToken(denC) ? `${numC}/${denC}` : `(${numC})/(${denC})`;
		s = s.slice(0, m.index) + rendered + s.slice(afterDen);
	}

	// \sqrt{x} / \sqrt x
	s = s.replace(/\\sqrt\s*\{([^{}]*)\}/g, (_, body) => {
		const c = convertMathExpression(body);
		return isSimpleToken(c) ? `√${c}` : `√(${c})`;
	});

	// \vec{v}, \hat{x}, \dot{x} — combining marks
	s = s.replace(/\\vec\s*\{?([a-zA-Z])\}?/g, "$1⃗");
	s = s.replace(/\\hat\s*\{?([a-zA-Z])\}?/g, "$1̂");
	s = s.replace(/\\bar\s*\{?([a-zA-Z])\}?/g, "$1̄");
	s = s.replace(/\\dot\s*\{?([a-zA-Z])\}?/g, "$1̇");
	s = s.replace(/\\tilde\s*\{?([a-zA-Z])\}?/g, "$1̃");

	// Named commands (longest first so \leq wins over \le)
	const names = Object.keys(COMMANDS).sort((a, b) => b.length - a.length);
	for (const name of names) {
		s = s.replaceAll(new RegExp(`\\\\${name}(?![a-zA-Z])`, "g"), COMMANDS[name]);
	}

	// Superscripts and subscripts: ^{...} / ^x / _{...} / _x
	const script = (marker: "^" | "_", table: Record<string, string>) => {
		let out = "";
		for (let i = 0; i < s.length; i++) {
			if (s[i] !== marker) {
				out += s[i];
				continue;
			}
			const [body, after] = readGroup(s, i + 1);
			const converted = convertMathExpression(body);
			const mapped = mapChars(converted, table);
			if (mapped !== null) {
				out += mapped;
			} else {
				out += marker === "^" ? `^(${converted})` : `_(${converted})`;
			}
			i = after - 1;
		}
		s = out;
	};
	script("^", SUPERSCRIPTS);
	script("_", SUBSCRIPTS);

	// Strip braces that remain around plain content
	s = s.replace(/\{([^{}]*)\}/g, "$1");

	return s.trim();
}

/**
 * Convert the $...$ / $$...$$ segments of a plain-text string in place.
 * For UI surfaces that render raw text (not markdown), where code-span
 * wrapping would show literal backticks.
 */
export function convertDollarSegments(text: string): string {
	return text
		.replace(/\$\$([^$]+)\$\$/g, (_, expr) => convertMathExpression(expr))
		.replace(/\$([^$\n]+)\$/g, (_, expr) => convertMathExpression(expr));
}

/**
 * Transform the math segments of a markdown string for terminal display.
 * Inline $...$ becomes `unicode` (inline code); display $$...$$ becomes a
 * plain code fence. Fenced code blocks and inline code are left untouched.
 */
export function transformMathInMarkdown(markdown: string): string {
	const lines = markdown.split("\n");
	const out: string[] = [];
	let inFence = false;
	let buffer: string[] | null = null; // accumulating a $$ block

	const transformInline = (line: string): string => {
		// Split out inline code spans so we never touch them
		return line
			.split(/(`+[^`]*`+)/)
			.map((part) => {
				if (part.startsWith("`")) return part;
				// Display math on one line: $$...$$
				part = part.replace(/\$\$([^$]+)\$\$/g, (_, expr) => `\`${convertMathExpression(expr)}\``);
				// Inline math: $...$ (not empty, no line breaks)
				part = part.replace(/\$([^$\n]+)\$/g, (_, expr) => `\`${convertMathExpression(expr)}\``);
				return part;
			})
			.join("");
	};

	for (const line of lines) {
		if (/^\s*(```|~~~)/.test(line)) {
			inFence = !inFence;
			out.push(line);
			continue;
		}
		if (inFence) {
			out.push(line);
			continue;
		}

		if (buffer !== null) {
			if (/^\s*\$\$\s*$/.test(line)) {
				out.push("```", ...convertMathExpression(buffer.join("\n")).split("\n"), "```");
				buffer = null;
			} else {
				buffer.push(line);
			}
			continue;
		}
		if (/^\s*\$\$\s*$/.test(line)) {
			buffer = [];
			continue;
		}

		out.push(transformInline(line));
	}

	// Unterminated $$ block: emit as-is
	if (buffer !== null) out.push("$$", ...buffer);

	return out.join("\n");
}
