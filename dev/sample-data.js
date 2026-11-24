/**
 * Sample catalogue for the demo: two servers with overlapping titles.
 * Titles that appear on both servers share TMDB ids, so r_flix shows them once.
 */
const G = { drama: 'Drama', scifi: 'Science Fiction', comedy: 'Comedy', thriller: 'Thriller', action: 'Action', anim: 'Animation' };

// [name, year, tmdb, genres, extra]
const movies = [
  ['Neon Harbor', 2023, 1001, [G.thriller, G.drama]],
  ['The Quiet Orbit', 2021, 1002, [G.scifi, G.drama], { transcode: true }],
  ['Paper Kingdoms', 2019, 1003, [G.anim, G.comedy]],
  ['Last Train to Elm', 2022, 1004, [G.thriller]],
  ['Salt & Static', 2018, 1005, [G.drama]],
  ['Glass Meridian', 2024, 1006, [G.scifi, G.action]],
  ['Midnight Kitchen', 2020, 1007, [G.comedy, G.drama]],
  ['Ember Protocol', 2024, 1008, [G.action, G.scifi], { transcode: true }],
  ['The Lantern Year', 2017, 1009, [G.drama]],
  ['Orbit of Foxes', 2022, 1010, [G.anim, G.comedy]],
  ['Hollow Signal', 2023, 1011, [G.thriller, G.scifi]],
  ['Velvet Harbor', 2016, 1012, [G.drama, G.comedy]],
  ['Rust & Rain', 2021, 1013, [G.action]],
  ['Small Gods of Tuesday', 2019, 1014, [G.comedy]],
];
const shows = [
  ['Paper Lanterns', 2022, 2001, [G.drama, G.thriller]],
  ['Station Eleven Thirty', 2021, 2002, [G.scifi, G.drama]],
  ['The Night Ledger', 2023, 2003, [G.thriller]],
  ['Breakfast Club of Ghosts', 2020, 2004, [G.comedy]],
];

const mk = (type) => ([name, year, tmdb, genres, extra = {}], i) => ({
  type, name, year, tmdb, genres, imdb: `tt${String(tmdb).padStart(7, '0')}`, added: i * 3 + 1, ...extra,
  overview: `${name} is a made-up ${type === 'Movie' ? 'film' : 'series'} used to demo r_flix. Its artwork is generated, and the clip you'll see playing is a test pattern.`,
});

/** Server A has most movies and shows 1-3; server B overlaps on several and has some of its own. */
export const serverA = {
  titles: [...movies.slice(0, 9).map(mk('Movie')), ...shows.slice(0, 3).map(mk('Series'))],
  watch: { 'Neon Harbor': { pos: 24, agoMin: 3 }, 'Paper Lanterns S1E1': { played: true, agoMin: 600 }, 'Paper Lanterns S1E2': { pos: 18, agoMin: 60 } },
};
export const serverB = {
  titles: [...movies.slice(5).map(mk('Movie')), ...shows.slice(2).map(mk('Series'))],
  watch: { 'Hollow Signal': { pos: 40, agoMin: 20 } },
};
