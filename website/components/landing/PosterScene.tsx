// The dusk poster's scene: sky, clouds, the sun and its orbit, the mountain, the three towers (static / native / react) with their lit windows,
// the sea with the sun's reflection, and the caption bar. Static markup, written out (a `.map` here would be a precompute job inside the native Poster);
// the lit/flash state lives on the <svg> in Poster.tsx.
export default function PosterScene() {
  return (
    <g className="scene">
      <rect width="400" height="300" className="sky0" />
      <rect y="168" width="400" height="62" className="sky1" />
      <rect y="230" width="400" height="40" className="sky2" />
      <rect y="270" width="400" height="30" className="sky3" />
      <g className="clouds">
        <rect className="cl c1" x="34" y="118" width="120" height="9" rx="4.5" />
        <rect className="cl c1" x="70" y="132" width="78" height="7" rx="3.5" />
        <rect className="cl c2" x="250" y="74" width="96" height="8" rx="4" />
        <rect className="cl c2" x="286" y="87" width="58" height="6" rx="3" />
      </g>
      <g className="birds">
        <polyline points="96,156 102,160 108,156" />
        <polyline points="114,146 119,149 124,146" />
        <polyline points="128,160 132,163 136,160" />
      </g>
      <circle className="orbit" cx="236" cy="236" r="122" />
      <circle className="sunf" cx="236" cy="236" r="92" />
      <polygon className="far" points="0,300 0,262 40,250 78,262 120,238 160,258 205,244 250,266 300,242 345,258 400,246 400,300" />
      <polygon className="fuji" points="0,300 0,282 40,262 92,206 108,201 124,206 178,262 214,300" />
      <polygon className="snow" points="92,206 108,201 124,206 133,215 121,221 113,213 105,224 97,213 84,215" />
      <g className="towers">
        <rect x="270" y="214" width="24" height="86" />
        <rect x="300" y="172" width="30" height="128" />
        <rect x="306" y="160" width="18" height="12" />
        <rect x="314" y="140" width="2" height="20" />
        <rect x="336" y="228" width="22" height="72" />
      </g>
      <g className="wins">
        <rect x="273.8" y="222" width="3" height="3" style={{ '--k': '0' }} />
        <rect x="280.5" y="222" width="3" height="3" style={{ '--k': '1' }} />
        <rect x="287.2" y="222" width="3" height="3" style={{ '--k': '2' }} />
        <rect x="273.8" y="231" width="3" height="3" style={{ '--k': '3' }} />
        <rect x="280.5" y="231" width="3" height="3" style={{ '--k': '4' }} />
        <rect x="273.8" y="240" width="3" height="3" style={{ '--k': '5' }} />
        <rect x="280.5" y="240" width="3" height="3" style={{ '--k': '6' }} />
        <rect x="287.2" y="240" width="3" height="3" style={{ '--k': '7' }} />
        <rect x="273.8" y="249" width="3" height="3" style={{ '--k': '8' }} />
        <rect x="280.5" y="249" width="3" height="3" style={{ '--k': '9' }} />
        <rect x="287.2" y="249" width="3" height="3" style={{ '--k': '10' }} />
        <rect x="280.5" y="258" width="3" height="3" style={{ '--k': '11' }} />
        <rect x="287.2" y="258" width="3" height="3" style={{ '--k': '12' }} />
        <rect x="273.8" y="267" width="3" height="3" style={{ '--k': '13' }} />
        <rect x="280.5" y="267" width="3" height="3" style={{ '--k': '14' }} />
        <rect x="287.2" y="267" width="3" height="3" style={{ '--k': '15' }} />
        <rect x="273.8" y="276" width="3" height="3" style={{ '--k': '16' }} />
        <rect x="287.2" y="276" width="3" height="3" style={{ '--k': '17' }} />
        <rect x="273.8" y="285" width="3" height="3" style={{ '--k': '18' }} />
        <rect x="280.5" y="285" width="3" height="3" style={{ '--k': '19' }} />
        <rect x="287.2" y="285" width="3" height="3" style={{ '--k': '20' }} />
        <rect x="305.2" y="180" width="3" height="3" style={{ '--k': '21' }} />
        <rect x="313.5" y="180" width="3" height="3" style={{ '--k': '22' }} />
        <rect x="321.8" y="180" width="3" height="3" style={{ '--k': '23' }} />
        <rect x="305.2" y="189" width="3" height="3" style={{ '--k': '24' }} />
        <rect x="313.5" y="189" width="3" height="3" style={{ '--k': '25' }} />
        <rect x="321.8" y="189" width="3" height="3" style={{ '--k': '26' }} />
        <rect x="305.2" y="198" width="3" height="3" style={{ '--k': '27' }} />
        <rect x="321.8" y="198" width="3" height="3" style={{ '--k': '28' }} />
        <rect x="305.2" y="207" width="3" height="3" style={{ '--k': '29' }} />
        <rect x="313.5" y="207" width="3" height="3" style={{ '--k': '30' }} />
        <rect x="321.8" y="207" width="3" height="3" style={{ '--k': '31' }} />
        <rect x="305.2" y="216" width="3" height="3" style={{ '--k': '32' }} />
        <rect x="313.5" y="216" width="3" height="3" style={{ '--k': '33' }} />
        <rect x="321.8" y="216" width="3" height="3" style={{ '--k': '34' }} />
        <rect x="305.2" y="225" width="3" height="3" style={{ '--k': '35' }} />
        <rect x="313.5" y="225" width="3" height="3" style={{ '--k': '36' }} />
        <rect x="305.2" y="234" width="3" height="3" style={{ '--k': '37' }} />
        <rect x="313.5" y="234" width="3" height="3" style={{ '--k': '38' }} />
        <rect x="321.8" y="234" width="3" height="3" style={{ '--k': '39' }} />
        <rect x="305.2" y="243" width="3" height="3" style={{ '--k': '40' }} />
        <rect x="313.5" y="243" width="3" height="3" style={{ '--k': '41' }} />
        <rect x="321.8" y="243" width="3" height="3" style={{ '--k': '42' }} />
        <rect x="313.5" y="252" width="3" height="3" style={{ '--k': '43' }} />
        <rect x="321.8" y="252" width="3" height="3" style={{ '--k': '44' }} />
        <rect x="305.2" y="261" width="3" height="3" style={{ '--k': '45' }} />
        <rect x="313.5" y="261" width="3" height="3" style={{ '--k': '46' }} />
        <rect x="321.8" y="261" width="3" height="3" style={{ '--k': '47' }} />
        <rect x="305.2" y="270" width="3" height="3" style={{ '--k': '48' }} />
        <rect x="321.8" y="270" width="3" height="3" style={{ '--k': '49' }} />
        <rect x="305.2" y="279" width="3" height="3" style={{ '--k': '50' }} />
        <rect x="313.5" y="279" width="3" height="3" style={{ '--k': '51' }} />
        <rect x="321.8" y="279" width="3" height="3" style={{ '--k': '52' }} />
        <rect x="305.2" y="288" width="3" height="3" style={{ '--k': '53' }} />
        <rect x="313.5" y="288" width="3" height="3" style={{ '--k': '54' }} />
        <rect x="321.8" y="288" width="3" height="3" style={{ '--k': '55' }} />
        <rect x="341.3" y="236" width="3" height="3" style={{ '--k': '56' }} />
        <rect x="349.7" y="236" width="3" height="3" style={{ '--k': '57' }} />
        <rect x="341.3" y="245" width="3" height="3" style={{ '--k': '58' }} />
        <rect x="349.7" y="245" width="3" height="3" style={{ '--k': '59' }} />
        <rect x="341.3" y="254" width="3" height="3" style={{ '--k': '60' }} />
        <rect x="349.7" y="254" width="3" height="3" style={{ '--k': '61' }} />
        <rect x="341.3" y="263" width="3" height="3" style={{ '--k': '62' }} />
        <rect x="341.3" y="272" width="3" height="3" style={{ '--k': '63' }} />
        <rect x="349.7" y="272" width="3" height="3" style={{ '--k': '64' }} />
        <rect x="341.3" y="281" width="3" height="3" style={{ '--k': '65' }} />
        <rect x="349.7" y="281" width="3" height="3" style={{ '--k': '66' }} />
        <rect x="341.3" y="290" width="3" height="3" style={{ '--k': '67' }} />
        <rect x="349.7" y="290" width="3" height="3" style={{ '--k': '68' }} />
      </g>
      <circle className="beacon b1" cx="282" cy="207" r="4" />
      <circle className="beacon b2" cx="315" cy="136" r="4" />
      <circle className="beacon b3" cx="347" cy="221" r="4" />
      <g className="tls">
        <text className="tl" x="264" y="210" textAnchor="end" style={{ '--t': '0' }}>
          static
        </text>
        <text className="tl" x="315" y="125" textAnchor="middle" style={{ '--t': '1' }}>
          native
        </text>
        <text className="tl" x="364" y="224" textAnchor="start" style={{ '--t': '2' }}>
          react
        </text>
      </g>
      <rect y="300" width="400" height="150" className="sea" />
      <rect y="299.5" width="400" height="1.5" className="horizon" />
      <rect className="rb" x="161" y="308" width="150" height="4" style={{ opacity: '0.95', '--i': '0' }} />
      <rect className="rb" x="175" y="318" width="122" height="4" style={{ opacity: '0.85', '--i': '1' }} />
      <rect className="rb" x="187" y="329" width="98" height="4" style={{ opacity: '0.75', '--i': '2' }} />
      <rect className="rb" x="198" y="342" width="76" height="4" style={{ opacity: '0.6', '--i': '3' }} />
      <rect className="rb" x="208" y="357" width="56" height="3" style={{ opacity: '0.5', '--i': '4' }} />
      <rect className="rb" x="217" y="373" width="38" height="3" style={{ opacity: '0.38', '--i': '5' }} />
      <rect className="rb" x="224" y="391" width="24" height="3" style={{ opacity: '0.28', '--i': '6' }} />
      <rect className="rb" x="229" y="410" width="14" height="2" style={{ opacity: '0.2', '--i': '7' }} />
      <g className="waves">
        <rect x="24" y="322" width="40" height="1.2" />
        <rect x="92" y="338" width="26" height="1.2" />
        <rect x="330" y="330" width="34" height="1.2" />
        <rect x="18" y="360" width="30" height="1.2" />
        <rect x="360" y="352" width="22" height="1.2" />
        <rect x="60" y="392" width="44" height="1.2" />
        <rect x="300" y="386" width="36" height="1.2" />
        <rect x="130" y="420" width="30" height="1.2" />
        <rect x="250" y="432" width="40" height="1.2" />
        <rect x="20" y="436" width="24" height="1.2" />
      </g>
      <rect className="tr t1" x="280" y="306" width="4" height="9" />
      <rect className="tr t1" x="280" y="319" width="4" height="7" />
      <rect className="tr t1" x="280" y="331" width="4" height="4" />
      <rect className="tr t2" x="313" y="306" width="4" height="12" />
      <rect className="tr t2" x="313" y="322" width="4" height="9" />
      <rect className="tr t2" x="313" y="336" width="4" height="6" />
      <rect className="tr t2" x="313" y="348" width="4" height="3" />
      <rect className="tr t3" x="345" y="306" width="4" height="7" />
      <rect className="tr t3" x="345" y="317" width="4" height="5" />
      <rect className="tr t3" x="345" y="327" width="4" height="3" />
      <rect y="450" width="400" height="30" className="cap" />
    </g>
  )
}
