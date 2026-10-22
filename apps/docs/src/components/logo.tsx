import type { SVGProps } from 'react'

/**
 * The geometry of the logo kit's mark (`logos/tula/svg/icon-mark-ink.svg`): a balance scale,
 * the solid pan the AI and the open pan the human, held level. Every stroke is `currentColor`,
 * so one asset serves the light and the dark page and is never rasterised.
 */
function MarkShapes({ stroke }: { stroke: number }) {
  return (
    <g
      fill='none'
      stroke='currentColor'
      strokeWidth={stroke}
      strokeLinecap='round'
      strokeLinejoin='round'
    >
      <path d='M0 -52V56M-60 -34H60M-26 56H26M-60 -34V-10M60 -34V-10' />
      <circle cx='-60' cy='4' r='14' fill='currentColor' stroke='none' />
      <circle cx='60' cy='4' r='14' />
    </g>
  )
}

/** The words of the lockup, outlined from Geist at weight 600 (SIL OFL), so no font is needed to draw it. */
const TULA_PATH =
  'M283.6 0Q204 0 166.5 -36.8Q129 -73.6 129 -152.8V-659.2H257V-165.2Q257 -127.6 273.2 -113.4Q289.4 -99.2 322.8 -99.2H398V0ZM45.4 -434.8V-534H398V-434.8Z M643 12Q561.6 12 514.5 -41.5Q467.4 -95 467.4 -190.2V-534H595.4V-221.6Q595.4 -154.6 617.5 -123.3Q639.6 -92 685.8 -92Q737.6 -92 766.4 -126.5Q795.2 -161 795.2 -226.8V-534H923.2V0H805.6L802.8 -146.6L819.4 -141.6Q806.6 -66.2 761.6 -27.1Q716.6 12 643 12Z M1162.4 0Q1103.6 0 1069 -30Q1034.4 -60 1034.4 -126.4V-710H1162.4V-139.4Q1162.4 -118.6 1172.7 -108.9Q1183 -99.2 1202.2 -99.2H1241.4V0Z M1455.6 12Q1372.4 12 1321.3 -26.4Q1270.2 -64.8 1270.2 -133.6Q1270.2 -203.2 1313.2 -242Q1356.2 -280.8 1443.6 -298L1621.2 -332.6Q1621.2 -389.6 1595.1 -418.2Q1569 -446.8 1518.4 -446.8Q1471.8 -446.8 1445.2 -425.5Q1418.6 -404.2 1409.4 -363.8L1279.2 -370.4Q1294.6 -454.6 1356.7 -500.3Q1418.8 -546 1518.4 -546Q1632.4 -546 1690.8 -488.7Q1749.2 -431.4 1749.2 -324.4V-129.8Q1749.2 -108.6 1756.5 -100.9Q1763.8 -93.2 1778.8 -93.2H1795.8V0Q1789.8 1.8 1776.4 3.1Q1763 4.4 1749.4 4.4Q1716.2 4.4 1690.3 -6.5Q1664.4 -17.4 1650 -43.5Q1635.6 -69.6 1635.6 -115.6L1647.2 -108Q1638.6 -72.8 1612.4 -45.5Q1586.2 -18.2 1546 -3.1Q1505.8 12 1455.6 12ZM1482 -81.2Q1524.6 -81.2 1555.7 -97.9Q1586.8 -114.6 1604 -144.9Q1621.2 -175.2 1621.2 -215.6V-245.6L1482.8 -217.6Q1440.4 -209.2 1421.5 -191.5Q1402.6 -173.8 1402.6 -145.6Q1402.6 -115 1423.3 -98.1Q1444 -81.2 1482 -81.2Z'
const AUTH_PATH =
  'M19.2 0 275.2 -710H434L690 0H553.6L495 -168H213.8L155.2 0ZM252 -279.2H457.2L354.8 -578.6Z M925 12Q843.6 12 796.5 -41.5Q749.4 -95 749.4 -190.2V-534H877.4V-221.6Q877.4 -154.6 899.5 -123.3Q921.6 -92 967.8 -92Q1019.6 -92 1048.4 -126.5Q1077.2 -161 1077.2 -226.8V-534H1205.2V0H1087.6L1084.8 -146.6L1101.4 -141.6Q1088.6 -66.2 1043.6 -27.1Q998.6 12 925 12Z M1529.6 0Q1450 0 1412.5 -36.8Q1375 -73.6 1375 -152.8V-659.2H1503V-165.2Q1503 -127.6 1519.2 -113.4Q1535.4 -99.2 1568.8 -99.2H1644V0ZM1291.4 -434.8V-534H1644V-434.8Z M1713.4 0V-710H1841.4V-411.8L1825 -412.2Q1833.4 -458.2 1857.2 -487.6Q1881 -517 1916.2 -531.5Q1951.4 -546 1993.4 -546Q2052.4 -546 2092.5 -520.3Q2132.6 -494.6 2153.1 -448.7Q2173.6 -402.8 2173.6 -343.4V0H2045.6V-311.8Q2045.6 -377.2 2023.9 -409.6Q2002.2 -442 1954.6 -442Q1902.6 -442 1872 -408.2Q1841.4 -374.4 1841.4 -308.8V0Z'

/**
 * The Tula mark on its own: the lockup's form below its minimum width (about 120 px).
 *
 * @param props - SVG attributes; the mark is drawn in the text colour.
 * @returns An `svg` of the mark, hidden from assistive technology: name the link that holds it.
 */
export function LogoMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox='-79 -39 158 100' aria-hidden='true' focusable='false' {...props}>
      <MarkShapes stroke={6} />
    </svg>
  )
}

/**
 * The "Tula Auth" lockup: the mark, "tula" in the text colour and "Auth" in the same colour at
 * 60% opacity, so a single `color` themes all of it. The kit's clear space (the height of a pan)
 * is left to the caller's padding, and its minimum width, 120 px, to the caller's CSS.
 *
 * @param props - SVG attributes; the lockup is drawn in the text colour.
 * @returns An `svg` of the lockup, hidden from assistive technology: name the link that holds it.
 */
export function LogoLockup(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox='0 -52 388 59' aria-hidden='true' focusable='false' {...props}>
      <g transform='translate(46.2 -29.3) scale(0.6)'>
        <MarkShapes stroke={6} />
      </g>
      <g fill='currentColor' transform='translate(111.5 0) scale(0.064)'>
        <path d={TULA_PATH} />
      </g>
      <g fill='currentColor' fillOpacity='0.6' transform='translate(243.4 0) scale(0.064)'>
        <path d={AUTH_PATH} />
      </g>
    </svg>
  )
}
