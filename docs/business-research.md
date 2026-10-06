# Life-Fi — Business Research & Positioning

Oct 6, 2026 · @Tina

## Executive summary

**Brand Life-Fi as "safety you don't have to wear": a camera-free guardian for older people living alone, built on the Wi-Fi already in the room.** The strongest argument is evidence that pendants fail when they are needed most. The biggest risk is accuracy and trust.

- **The bet.** A \~€10 ESP32-S3 and a router can catch falls, fainting and breathing stops without a camera or wearable, and alert a phone within seconds.
- **The need.** About 30% of people over 65 fall each year. In one study, 80% of alarm owners did not use their alarm when they fell alone. Bulgaria is 24% aged 65+, short of nurses, and has lost many young people to emigration.
- **The gap.** Wearables dominate fall detection but rely on being worn and pressed. Radar costs €83–240 per room. Big Wi-Fi players (Comcast, ADT/Origin, Cognitive) sell motion alerts, not validated fall or breathing care. No Bulgarian contactless fall-detection product was found.
- **Top strengths.** Nothing to wear, no images, very low hardware cost, detects fainting a button can't report, local processing.
- **Top weaknesses.** One link and one person per room, false alarms from hard sit-downs or pets, a prototype with little data, and medical-device rules if breathing is sold as health monitoring.
- **How to present it.** Open with a person's story, run a live fall on stage with a phone alert, show the raw signal to prove privacy, then show honest error rates. Honesty is the differentiator in a category known for over-promising.
- **Business path.** Care homes and municipal home-care first (clear budgets, many rooms), families second (the emotional story), telecoms later (reach).

**Beyond older people.** The masterbrand is "rooms that notice, without cameras", with lines for Home, Care, Safe Room (bathrooms and public toilets) and Spaces (schools, offices, hotels). Claim "privacy-first, designed for GDPR", never "GDPR doesn't apply": breathing and falls about an identifiable person are still health data.

**Disaster use.** A portable rescue device for earthquakes, fires, car crashes or attacks scores 1.75–2.55 out of 5, against 4.35 for care. Radar already does that job, and police use would break the privacy brand. Keep one vision line in the pitch instead: fixed sensors can tell firefighters which rooms still had people in them (see the disaster option section).

## The product and the problem it solves

Life-Fi turns an ordinary Wi-Fi signal into a safety sensor: one \~€10 ESP32-S3 board and a router notice when someone falls, stops breathing or leaves a bed, and send an alert to a phone. No camera, nothing to wear, nothing to charge.

**How it works, in one breath.** The board pings the router about 100 times a second. Each reply carries channel state information (CSI): how the signal bent and faded on its way across the room. A body that moves, breathes or falls changes that pattern. Software on a laptop reads the pattern and reports presence, motion, breathing rate, falls and "fainted" (a fall followed by stillness).

**The problem.** An older person who falls alone may lie on the floor for hours before anyone knows. Today's answers each ask something of that person:

- A **pendant or watch** must be worn, charged and pressed. It is often off at night or in the shower, exactly when falls happen.
- A **camera** sees everything. Many people refuse one in a bedroom or bathroom.
- A **radar sensor** works well but costs hundreds of euros per room.

**One engine, three settings.** The same sensor output is shaped by a profile:

| Profile | Who it serves | The question it answers | Key alerts |
| --- | --- | --- | --- |
| Home | An older person living alone, and their family | "Is Mum OK?" | fall, fainted, breathing stopped, long inactivity, sensor offline |
| Clinic | A patient room, the night nurse | "Is the patient breathing and in bed?" | breathing stopped, bed exit at night, fall |
| School | A classroom or corridor, the caretaker | "Is the room in use? Did someone fall?" | fall, after-hours occupancy; no breathing data stored |

**What it deliberately does not do.** No heart rate, no identifying who someone is, no sleep stages, no images. One single-antenna link cannot do these credibly, and leaving them out is part of the privacy story.

## Market and audience

The need is large and growing, and Bulgaria is one of the sharpest cases in Europe. Nearly a quarter of Bulgarians are 65 or older, many live alone, and nurses are about half as many per person as the EU average.

**The problem in numbers**

- About **30% of adults over 65 fall every year**. A fall where the person cannot get up for an hour or more counts as severe ([World Falls Guidelines, 2022](https://academic.oup.com/ageing/article/51/9/afac205/6730755)).
- About **1 in 5 of those falls becomes a "long lie"** of over an hour. That leads to dehydration, pressure sores, hypothermia and muscle damage ([University of Sheffield, Long Lies Study](https://sheffield.ac.uk/cure/current-trials/long-lies-study)).
- In a study of people aged 91–105, **82% of falls happened when they were alone**, and **80% of alarm owners did not use the alarm** when they fell. 97% of long lies involved an alarm that was never pressed ([Fleming & Brayne, BMJ 2008](https://pmc.ncbi.nlm.nih.gov/articles/PMC2590903/)). *This is the single strongest number for the pitch.*
- In the EU, falls among people 65+ cause about **35,800 deaths, 3.8 million emergency visits and €25 bn in treatment costs** a year. **56% of fall injuries at home happen in the living room or bedroom**, and 15% in the bathroom ([EuroSafe/EUPHA fact sheet](https://db.eupha.org/repository/sections/ipsp/Factsheet_falls_in_older_adults_in_EU.pdf)).
- Worldwide, falls kill about **684,000 people a year** ([WHO](https://www.who.int/news-room/fact-sheets/detail/falls)).

**Why Bulgaria, why now**

- **24.0% of Bulgarians are 65+**, the 3rd-highest share in the EU after Italy and Portugal ([Eurostat](https://ec.europa.eu/eurostat/statistics-explained/index.php?title=Population_structure_and_ageing)). That is **1.54 million people**, rising above 30% in Vidin, Gabrovo and Smolyan ([NSI, 2024](https://www.nsi.bg/en/file/28604/Population2024_en_F59F6N4.pdf)).
- The population fell by **11.5% between 2011 and 2021**, with about **344,000 lost to emigration** ([Sofia Globe](https://sofiaglobe.com/2022/10/03/bulgarias-2021-census-final-results-confirm-large-drop-in-population/)). Many parents now live alone while their children work abroad.
- Across the EU, **40% of women and 19% of men aged 65+ live alone** ([Eurostat, 2020](https://ec.europa.eu/eurostat/web/products-eurostat-news/-/DDN-20200623-1)).
- Bulgaria has **4.4 nurses per 1,000 people, against 8.5 in the EU**. It is short of 16,900–29,000 nurses, and about a third of new graduates emigrate ([OECD/EC Country Health Profile 2025](https://www.oecd.org/content/dam/oecd/en/publications/reports/2025/12/country-health-profile-2025-country-notes_7e72146d/bulgaria_242bb908/cd5706eb-en.pdf)). Fewer eyes on wards means automated alerts matter more.

**Market size** (commercial research estimates; firms disagree widely, so quote them as a range, not a fact)

| Market | Size | Growth | Source |
| --- | --- | --- | --- |
| Medical alert systems (PERS) | USD 11.8 bn (2026) → 15.2 bn (2030) | 6.4% a year | [Grand View Research](https://www.grandviewresearch.com/industry-analysis/medical-alert-personal-emergency-response-system-pers-market) |
| Fall detection systems | USD 0.52 bn (2025) → 0.94 bn (2033); wearables hold 68.7% | 7.8% a year | [Grand View Research](https://www.grandviewresearch.com/industry-analysis/fall-detection-systems-market-report) |
| Ambient assisted living | USD 10.1 bn (2025) → 75.7 bn (2034) | 25% a year | [Straits Research](https://straitsresearch.com/report/ambient-assisted-living-market) |
| Wi-Fi sensing | USD 1.2 bn (2025) → 9.8 bn (2034); weak source | 27.5% a year | [MarketIntelo](https://marketintelo.com/report/wi-fi-sensing-market) |

The useful point for the pitch: wearables still hold about two-thirds of fall detection, yet the evidence above shows people often do not use them. That gap is Life-Fi's opening.

**Segments: who uses it, who pays**

| Segment | User | Buyer | What they pay for | Priority |
| --- | --- | --- | --- | --- |
| Families of older people living alone | Older parent | Adult child, often abroad | Peace of mind, phone alerts | 1 — the emotional story |
| Care homes and hospital wards | Residents, patients | Facility manager, head nurse | Fewer unseen falls at night, staff time | 2 — the scalable business |
| Municipal home-care and social services | Older clients at home | Municipality, social services, EU-funded projects | Remote safety for many clients | 2 — pilots and grants |
| Telecoms and ISPs | Their subscribers | Operator | A paid add-on to the home router | 3 — later partnership |
| Schools | Pupils, staff | School, municipality | Room use and fall alerts | 4 — secondary; consent is harder |

## Competitive landscape

No one sells a cheap, validated Wi-Fi product for falls and breathing today. That is Life-Fi's opening, and also its warning: big Wi-Fi players stopped at motion alerts, and health sensing went to radar.

| Alternative | Technology | Price | Falls | Breathing | Camera-free, nothing to wear | Weak spot |
| --- | --- | --- | --- | --- | --- | --- |
| **Life-Fi** | Wi-Fi CSI, ESP32-S3 + router | \~€10 hardware per room | Yes (prototype) | Yes, when still | Yes | Prototype; one person; one link |
| [Medical Guardian](https://www.seniorliving.org/medical-alert-systems/medical-guardian-vs-life-alert/) | Pendant / PERS | $31.95–46.95 a month, +$10 for fall detection | Yes, add-on | No | No (wearable) | Must be worn and charged |
| [Life Alert](https://www.seniorliving.org/medical-alert-systems/medical-guardian-vs-life-alert/) | Button pendant | $49.95–98.85 a month + $197 setup, 3-year contract | No automatic detection | No | No | Useless if not pressed |
| [Apple Watch](https://support.apple.com/en-us/108896) | Wrist accelerometer | Watch price | Yes, auto-on at 55+ | No | No | "Cannot detect all falls"; must be worn |
| A1 Bulgaria Telecare | Wristband, SOS, GPS | Municipal programme, user price not public | Yes | No (pulse, SpO₂) | No | \~500 users in \~90 municipalities |
| [Aqara FP2](https://us.aqara.com/products/presence-sensor-fp2) | 60 GHz mmWave radar | €82.99 | Yes, ceiling mount only | Claims sleep breathing | Yes | 8× Life-Fi hardware cost; "not a medical device" |
| Vayyar Care | 4D imaging radar | \~$240 | Yes | No | Yes | Lost Alexa Together channel; layoffs in 2024 |
| [Kepler Vision](https://keplervision.eu/en/frequently-asked-questions/) | Camera AI, faces blurred | Not public | Yes (care homes) | No | No (camera) | \~10 false alarms a month by its own FAQ |
| [Cognitive Systems WiFi Motion](https://www.cognitivesystems.com/) | Wi-Fi sensing licensed to 160+ ISPs | B2B, via ISP | Claims "fall risk" | Claims vitals | Yes | No public validation; motion is the real product |
| Comcast / Verizon / Plume Wi-Fi motion | Wi-Fi sensing in ISP routers | Free with service | No | No | Yes | Security motion only; privacy backlash |
| [ESPectre](https://github.com/francescopace/espectre) | Open-source ESP32 CSI | Free, \~€10 board | No | No | Yes | Explicitly not a safety system |

**Three lessons from the market**

1. **Wi-Fi sensing products keep dying as standalone devices.** Linksys Aware reached end of life in 2024 ([Linksys](https://www.linksys.com/pages/linksys-product-end-of-life)). MIT Technology Review noted in 2024 that no commercially viable Wi-Fi device for breathing or falls existed yet. Value went to licensing through ISPs.
2. **The big money has arrived.** ADT bought Origin Wireless/Origin AI and its 200+ patents for **$170 million** (8-K filing, February 2026) and talks about "aging in place" products for 2027. Comcast launched opt-in Wi-Fi motion in August 2026 (TechCrunch, 18 August 2026). This validates the category and means a well-funded competitor is coming.
3. **Real homes are noisy.** In an Origin/ADT field study across 15 homes, 63.1% of detections were false alarms from pets and robot vacuums before a fix brought it to 8.4% ([arXiv 2506.04322](https://arxiv.org/abs/2506.04322)). Plan for this in testing and in the pitch.

**Where Life-Fi sits.** Against wearables it wins on dignity and on the people who don't press the button. Against radar it wins on cost (about €10 against €83–240). Against ISP Wi-Fi motion it wins on purpose: care alerts for falls and breathing, not security. Locally, Bulgaria has wristband telecare but no contactless fall detection startup was found.

## Advantages and value proposition

The core promise: **protection that asks nothing of the person being protected.** Every other advantage supports that line.

| Advantage | Why it matters to the buyer | How to prove it on stage |
| --- | --- | --- |
| Nothing to wear or charge | Works at 3 a.m. and in the bathroom, when pendants are on the nightstand | Fall with no device on the body; the phone buzzes |
| No camera, no images | Accepted in bedrooms, bathrooms and classrooms; nothing to leak that shows a face | Show the raw CSI heatmap: "this is all we ever see" |
| Very low hardware cost (\~€10 board + an existing router) | Affordable for pensioners and for a hospital ward with 40 rooms | Hold up the board next to a radar sensor's price tag |
| Passive and automatic | A person who has fainted cannot press a button | Staged faint: fall, 20 s of stillness, "fainted suspected" alert |
| Breathing monitoring without contact | A breathing stop is detected in \~13–18 s, not at the next check-in | Breath-hold on stage; dashboard flags it |
| Local processing | Health data stays in the home; no raw signal is stored; easier GDPR story | Pull the internet cable; alerts still reach the dashboard on the LAN |
| One engine, three profiles | Same hardware sells into homes, care facilities and schools | Switch profile live; alerts and pages change |
| Honest confidence | The system says "uncertain" or "warming up" instead of guessing | Point to the uncertainty indicators |
| Open, hackable stack | Fits smart homes (Home Assistant/MQTT on the roadmap) and research use | Mention the open contracts and replay tool |

**Three emotional benefits to lead with**, ahead of the technical ones:

1. **Dignity** — no camera watching, no "I need help" pendant around the neck.
2. **Independence** — the parent stays in their own home longer.
3. **Peace of mind** — the son in Germany or the night nurse knows within seconds, not hours.

## Disadvantages, weaknesses and risks

The biggest weakness is **trust in a safety claim**: a missed fall or a stream of false alarms ends the product, and one Wi-Fi link has real physical limits. Say these out loud before a judge does — it reads as maturity, not weakness.

**Technical**

| Weakness | Effect | Severity | Mitigation / honest framing |
| --- | --- | --- | --- |
| One link, one antenna | Blind spots; a person far from the router–board line is seen weakly | High | Placement guide; second \~€10 node is the cheapest big upgrade |
| More than one person in the room | Breathing, breathing-stop and fall rules assume one person | High | Home and Clinic are single-occupant by design; UI states it |
| False alarms from hard sit-downs or dropped objects | Alert fatigue; family stops trusting it | High | Fall + stillness confirmation; report false alarms per hour with confidence intervals |
| Room-specific behaviour | Posture model trained in one room is weaker in a new one | Medium | Rules carry the core alerts; on-site adaptation and recalibration |
| Still person presence depends on calibration | A sleeping person may drift to "uncertain" | Medium | Empty-room calibration prompt; "uncertain" state, never a silent miss |
| Router dependence | Some routers limit pings or change channels; a reboot breaks sensing | Medium | Fixed-channel router in the kit; "sensor offline" alert within 15 s |
| Breathing stop takes \~13–18 s | Not a clinical apnea monitor | Medium | Position as a safety net, not a medical monitor |
| Laptop-based engine today | Not a consumer product yet | Medium | Roadmap: engine on a Raspberry Pi-class hub or on the router |
| Small training data | Accuracy numbers come from few rooms and few people | Medium | Session- and room-level test splits; publish honest numbers |

**Market and business**

- **Category scepticism.** Wi-Fi sensing has been promised for a decade; buyers and judges may have seen bold claims that did not hold up.
- **Big players can copy it.** Router makers and ISPs can push motion sensing to millions of homes by software update.
- **The buyer is not the user.** The elderly person rarely buys; the adult child, the municipality or the clinic does. Each needs a different pitch.
- **Installation.** Placement matters (3–5 m link, chest height, line of sight). Seniors cannot set it up alone.
- **Liability.** If an alert is missed and someone dies, who is responsible?

**Regulatory and ethical**

- **Medical-device line.** Claiming to "detect falls" or "monitor breathing" for a health purpose can make the software a medical device under EU MDR — slow and costly to certify.
- **Health data.** Breathing, falls and inactivity are special-category data under GDPR Art. 9; consent and retention rules apply.
- **Surveillance worry.** "Wi-Fi that sees through walls" sounds alarming. A neighbour's signal or a misused system could reveal when a home is empty.
- **Consent in schools and care homes.** Pupils and patients cannot meaningfully opt out of a room sensor.

**Team and stage**

- A student hackathon team, with no clinical partner, no field trial and one demo room so far.
- The demo itself is a risk: venue Wi-Fi noise, a crowded room that is never empty, a live failure. Keep the replay with its visible banner ready.

## SWOT analysis

The strengths are about people (dignity, cost, privacy); the weaknesses are about physics and maturity. The plan must turn the weaknesses into stated limits before competitors or critics turn them into headlines.

| | Helpful | Harmful |
| --- | --- | --- |
| **Internal** | **Strengths**<br>Nothing to wear, charge or press<br>No camera: sees motion, never faces<br>About €10 per room on an existing router<br>Catches fainting and breathing stops<br>Local processing, honest confidence<br>One engine for home, clinic and school | **Weaknesses**<br>One link: blind spots, placement matters<br>Breathing and falls assume one person<br>False alarms from hard sit-downs<br>Weaker in rooms it was not trained in<br>Laptop engine: not a product yet<br>Small data set, no field trial |
| **External** | **Opportunities**<br>Ageing population, children abroad<br>Shortage of nurses and home carers<br>Wi-Fi sensing becoming a standard<br>Telecoms looking for paid home services<br>Municipal and EU-funded home-care schemes<br>Smart-home links (Home Assistant) | **Threats**<br>Router makers and ISPs add it by update<br>Radar sensors keep getting cheaper<br>Medical claims pull it under EU MDR<br>"Wi-Fi that sees you" privacy backlash<br>Liability after a missed fall<br>Smartwatches with automatic fall alerts |

Read across the rows: each internal weakness has a matching external threat (single link ↔ cheaper radar; false alarms ↔ liability), so fixing accuracy is also the best defence.

## Branding

Brand Life-Fi as **a quiet guardian, not a gadget**: warm, calm and honest about its limits. The technology is the proof, never the headline.

**Name.** Keep "Life-Fi". It is short, says Wi-Fi, and puts *life* first. Two cautions: check trademark and domain clashes ("Li-Fi" is an existing light-based technology and will be confused in speech), and always say it as "Life-Fi, Wi-Fi that looks after life" the first time.

**Tagline options** (pick one and use it everywhere):

| Tagline | Tone | Best for |
| --- | --- | --- |
| Your Wi-Fi, watching over them. | Warm, family | Home, consumer pitch |
| Safety you don't have to wear. | Benefit-first, contrasts with pendants | Judges, investors |
| No camera. No wearable. Just care. | Privacy-first | Clinic and school buyers |
| The router already in the room, now on guard. | Cost and simplicity | B2B, ISPs, telecoms |

**Brand pillars**

1. **Invisible care** — nothing to wear, charge, press or look at.
2. **Privacy by physics** — the sensor cannot see faces; data stays local.
3. **Honest by design** — says "uncertain" when unsure; publishes its real error rates.
4. **Within reach** — hardware cheaper than a month of a pendant subscription.

**Voice and visual direction**

- Calm, plain words. Talk about people ("Grandma Mara"), not subcarriers.
- Colours: soft, warm neutrals with one reassuring accent (teal or green for "all OK"); red only for a real alert.
- Imagery: a lived-in home, an empty hallway at night, a phone notification. Never a person under a scanning beam.
- Icon idea: the Wi-Fi arcs forming a heartbeat or a sheltering roof.

**Messaging do's and don'ts**

| Say | Avoid | Why |
| --- | --- | --- |
| "Notices a fall and alerts family within seconds" | "Prevents falls" or "saves lives" | It detects, it does not prevent; unprovable claims hurt trust |
| "Assistive notification, not a medical device" | "Diagnoses", "medical-grade", "monitors vital signs" | Medical claims trigger EU MDR |
| "Sees movement, never faces" | "Sees through walls" | Sounds like surveillance |
| "Works best for one person in a room" | "Tracks everyone in the house" | Over-promise, and creepy |
| "Breathing rate when the person is still" | "Heart rate", "sleep stages" | Not credible on this hardware |
| "About €10 of hardware plus your router" | "Free" | Setup, support and a hub still cost money |

## Branding beyond older people

**Brand Life-Fi as a platform: "rooms that notice, without cameras". Use older people living alone as the first story, not the whole identity.** The same sensor and engine work in any room where people need watching over but cameras are unwelcome. The privacy argument is strong, but "privacy-first" is honest; "GDPR doesn't apply" is not (see below).

**Umbrella brand and product lines**

| Line | Setting | What it notices | One-line promise |
| --- | --- | --- | --- |
| **Life-Fi** (masterbrand) | Any room | Presence, motion, falls, stillness, breathing when allowed | Rooms that notice. No cameras. |
| Life-Fi Home | Anyone living alone: older people, people with disabilities or chronic illness, a student far from family | Falls, fainting, long inactivity | Someone's looking out for you, nobody's looking at you. |
| Life-Fi Care | Hospital wards, care homes, rehab centres | Bed exit at night, falls, breathing stopped | An extra pair of eyes for the night shift, with no eyes. |
| Life-Fi Safe Room | Accessible and public toilets, hotel bathrooms, changing rooms | A fall, or no movement for too long | Help where cameras can never go. |
| Life-Fi Spaces | Schools, universities, offices, dormitories, hotels | Room in use or empty, after-hours presence, falls | Know your rooms, not your people. |

**Other settings, ranked by fit**

| Setting | Value to the buyer | Privacy and legal note | Fit |
| --- | --- | --- | --- |
| Accessible and public toilets, hotel bathrooms | Finds a person who collapsed in the one place cameras are banned | Usually anonymous visitors; no breathing stored | **High** — the clearest "only Life-Fi can do this" case |
| Hospitals, care homes | Night-time falls and bed exits with fewer staff | Health data; needs a care or consent basis | **High** — already a profile |
| People of any age living alone (disability, epilepsy, chronic illness) | Same as Home | Health data; must not claim to detect seizures or diagnose | **High** — same product, wider audience |
| Schools and universities | After-hours occupancy, falls in corridors and toilets | Minors; no breathing; AI Act bans emotion inference in schools | Medium — consent and parents' trust needed |
| Offices and meeting rooms | Real room use, heating and lighting only when occupied | Anonymous occupancy level is low-risk | Medium — crowded market (PIR, radar, thermal); one link counts poorly |
| Hotels, dormitories | Energy savings; guest safety in bathrooms | Guests must be told; no recordings | Medium |
| Lone workers (night guards, warehouses) | Man-down alert | Employee monitoring rules and labour law; must not be used to track productivity | Low–medium — risky for the brand |
| Home security, empty-home alerts | Intrusion alerts | Low risk | Low — ISPs give this away free |
| Baby or child sleep | Breathing alerts | Implies preventing infant death: a medical claim | **Avoid** |
| Prisons and police cells | Welfare checks | Surveillance of people who cannot refuse | **Avoid** for this brand |

**What "GDPR-friendly" can and cannot honestly claim**

Life-Fi is much easier to defend than cameras, but GDPR still applies whenever the data relates to a person who can be identified, such as the one resident of a flat or the patient in bed 4 ([GDPR Art. 4](https://gdpr-info.eu/art-4-gdpr/)). Breathing, falls and inactivity about that person are health data ([Art. 9](https://gdpr-info.eu/art-9-gdpr/)). Systematic monitoring can require a data protection impact assessment ([Art. 35](https://gdpr-info.eu/art-35-gdpr/)). The customer who installs it is usually the data controller, so compliance depends on how they use it.

| Honest claims | Claims to avoid |
| --- | --- |
| No cameras, no images, no microphones | "GDPR doesn't apply" |
| Cannot recognise or identify who someone is | "Anonymous in every setting" |
| Processing stays on site; raw signal is not stored | "GDPR-compliant" or "GDPR-certified" (compliance belongs to each deployment) |
| Privacy by design and data minimisation ([Art. 25](https://gdpr-info.eu/art-25-gdpr/)): breathing off and never stored in Spaces | "Can't be misused" |
| Designed to make GDPR compliance easier | "Safe for any kind of monitoring" |

Recommended privacy line: **"No cameras. No identities. Data stays on site. Designed for GDPR."**

**How this changes the pitch**

- Still open with one person's story; judges remember one face, not ten markets.
- Add one platform slide after the demo: the same board in a home, a hospital room, a public toilet and a classroom.
- Use Safe Room as the surprise: a bathroom is where falls happen and cameras are banned. It shows the privacy advantage is a market, not just a feature.

## How to present the product

Open with a person, prove it with a live fall, close with honesty. A 5-minute pitch that follows this order wins on story, demo and credibility at once.

**Pitch structure (5 minutes)**

1. **Hook, 0:00–0:30.** A story: "Mara is 78 and lives alone in Varna. Her son works in Germany. Last winter she fell in the bathroom at night and lay on the floor until morning. She had a panic button. It was on her nightstand."
2. **Problem, 0:30–1:00.** One or two numbers on falls and older people living alone (see Market). Why pendants, cameras and radar each fall short.
3. **Solution, 1:00–1:30.** "Life-Fi turns the Wi-Fi already in the room into a guardian. No camera, nothing to wear." Hold up the board.
4. **Live demo, 1:30–3:00.** The centre of the pitch (below).
5. **Why it is different, 3:00–3:30.** The comparison table from Competitive landscape, reduced to four ticks: no wearable, no camera, low cost, breathing.
6. **Honest limits, 3:30–4:00.** "One person per room works best. It is a safety net, not a medical device. Here are our real error rates." This is where you earn trust.
7. **Business and next steps, 4:00–4:40.** Who pays, the three profiles, the roadmap (second node, hub, pilot with a care home).
8. **Close, 4:40–5:00.** Back to Mara: "With Life-Fi, her son's phone would have buzzed in ten seconds."

**Demo plan**

- [ ] Calibrate the empty room before the audience arrives.
- [ ] Show presence: walk in; dashboard goes from empty to present.
- [ ] Show breathing: sit still; the breathing wave appears. Hold breath; "breathing stopped" fires.
- [ ] Show the fall: fall onto the mat, lie still; "fall" then "fainted suspected"; a judge's phone (subscribed to the ntfy topic) buzzes.
- [ ] Show privacy: the raw CSI heatmap — "this is everything the system ever sees".
- [ ] Switch to Clinic profile: bed exit alert at night.
- [ ] Fallback ready: replay of a recorded fall with the visible "REPLAY" banner. Never hide that it is a replay.

**Tough questions and short answers**

| Likely question | Answer |
| --- | --- |
| How accurate is it? | Give the measured fall recall and false alarms per hour with confidence intervals, and the test setup. Never a single "98%". |
| What if two people are in the room? | Fall detection still sees big motion; breathing needs one person. Home and Clinic target single occupants. |
| Is this not surveillance? | It cannot see faces or identify anyone; processing is local; breathing is not even stored in School mode. |
| Why not just a smartwatch? | Many older people don't wear it at night, forget to charge it, or can't press it after fainting. |
| Big companies already do Wi-Fi motion. Why you? | They sell motion for security; we target falls and breathing for care, at a tenth of radar cost, open and local. |
| Is it a medical device? | No. It is an assistive notification. Certification would be a later, separate step with a clinical partner. |
| What does it cost? | About €10 of hardware per room plus a small hub; a service price is in the business model. |
| Does it work through walls / in other rooms? | It is designed for one room per sensor. More rooms means more boards. |

## Business model and go-to-market

Start where the pain and the budget meet — care homes and municipal home-care — and use the family story to win attention. Sell a service, not a board: the board is €10, the value is the alert that arrives.

**Revenue options** (prices are proposals to test, not market data)

| Model | Customer | Proposed price | Pros | Cons |
| --- | --- | --- | --- | --- |
| Home kit + subscription | Family of an older person | \~€79 kit (2 sensors + small hub) + \~€5 a month | Undercuts pendants at $30–50 a month; recurring revenue | Installation and support at home; churn |
| Per-room licence | Care homes, hospital wards | \~€3–5 per bed a month, hardware at cost | Many rooms per sale; clear staff-time ROI | Long sales cycles; procurement; liability questions |
| Municipal pilot | Social services, home patronage | Project fee, EU or national programme funding | Bulgaria already funds telecare in \~90 municipalities | Grant-driven, slow, political |
| ISP / telecom partnership | A1, Vivacom, Yettel subscribers | Revenue share on an add-on | Huge reach; router already in the home | Needs a mature product; big partners dictate terms |
| Open core | Makers, researchers, Home Assistant users | Free software, paid hosted alerts or support | Community, credibility, free testing | Low revenue; easy to copy |

**Unit economics in one line.** Hardware is about €10 per sensor plus a hub; the real costs are installation, support and the alert service. Keep hardware near cost and charge for the monitoring.

**Go-to-market, step by step**

1. **Hackathon (now):** win credibility with an honest live demo and published error rates.
2. **Pilot (next 6 months):** one care home or one municipal home-patronage service in Varna, with consent, 5–10 rooms, a nurse as co-designer.
3. **Prove it:** measure falls caught, false alarms per room per night and staff response time. Publish the result.
4. **Productise:** move the engine from a laptop to a small hub; add the second sensor; one-click calibration; installer guide.
5. **Scale:** sell to care-home chains and municipalities; approach a telecom for the home market.
6. **Decide on certification:** stay a non-medical safety notification, or partner with a clinic to certify breathing alerts under EU MDR.

**Regulatory guard-rails for the business**

- Under EU MDR guidance, software that raises alarms from a person's physiological parameters is a medical device, and monitoring **respiration** can be Class IIb ([MDCG 2019-11 Rev.1](https://health.ec.europa.eu/document/download/b45335c5-1679-4c71-a91c-fc7a4d37f12b_en?filename=md_mdcg_2019_11_guidance_qualification_classification_software_en.pdf)). Until certified, sell presence, fall and safety notification; present breathing as a research feature. *Confirm with a regulatory advisor before selling.*
- Health data falls under [GDPR Art. 9](https://gdpr-info.eu/art-9-gdpr/): use explicit consent, local processing, short retention.
- The EU AI Act bans emotion inference in schools ([Art. 5](https://artificialintelligenceact.eu/article/5/)). The School profile must stay at occupancy and falls.
- The new [IEEE 802.11bf-2025](https://standards.ieee.org/ieee/802.11bf/11574/) Wi-Fi sensing standard (published September 2025) helps: future routers will support sensing natively, so Life-Fi's software can outlive the ESP32.

## Option: a portable Life-Fi for disasters

**Verdict: don't pivot to a portable rescue device.** The one disaster idea worth keeping is the opposite of portable: room sensors that already know **who was in which room when the fire alarm went off** or the earthquake hit. It scores 3.65 out of 5, against 4.35 for the care focus and 2.3 or less for rubble, car-crash and hostage use.

**Why portable rescue is a poor fit for this hardware**

- **Wi-Fi sensing needs a transmitter and a receiver on opposite sides of the person, and a calm, calibrated room.** After a collapse there is no empty-room baseline, no known geometry and constant motion from rescuers, machines and settling debris. Rescue teams already stop all work for a "quiet" signal just to listen ([INSARAG Guidelines](https://insarag.org/wp-content/uploads/2021/09/INSARAG20Guidelines20Vol20II2C20Man20B.pdf)).
- **2.4 GHz loses a lot through concrete.** Typical losses are 12–25 dB for 100 mm concrete and 25–30+ dB for reinforced concrete ([vendor table](https://interline.pl/Information-and-Tips/Building-Materials-and-Wi-Fi-Signal-Loss-2.4-GHz-and-5-GHz)). Radio cannot pass continuous metal ([NIJ report](https://www.ojp.gov/pdffiles1/nij/nlectc/240729.pdf)).
- **The systems that work are radar, not Wi-Fi.** MIT's through-wall breathing work uses FMCW radar with several antennas ([Vital-Radio](https://witrack.csail.mit.edu/vitalradio/content/vitalradio-paper.pdf)). Even with signal strength from many links, one link alone "cannot reliably detect breathing" ([Patwari et al.](https://arxiv.org/abs/1109.3898)). No peer-reviewed study of Wi-Fi CSI finding people in rubble was found.
- **Heat kills electronics.** NIST found all 7 firefighter radios tested failed at 160 °C ([NIST, 2014](https://www.nist.gov/news-events/news/2014/12/nist-tests-firefighters-portable-radios-may-fail-elevated-temperatures)). Radio passes through smoke easily; the board does not survive the fire.

**Who already does each job**

| Scenario | Existing solution | Price / status | Gap for Life-Fi? |
| --- | --- | --- | --- |
| Earthquake rubble | [FINDER](https://dhs.gov/archive/science-and-technology/news/2015/05/05/finder-helps-save-four-nepal) heartbeat radar (found 4 men under \~3 m of debris in Nepal, 2015); [GSSI LifeLocator](https://www.geophysical.com/search-rescue) (breathing at 7 m depth); search dogs; listening devices | Professional USAR kit; no public price | No — radar is far ahead |
| Fire, finding people in smoke | Camero Xaver through-wall radar, used by Spanish fire services ([Guardian Spain](https://guardianspain.com/en/portfolio-item/camero-firefighters/)); thermal cameras | Xaver 100 about $9,000 ([NIJ](https://www.ojp.gov/pdffiles1/nij/nlectc/240729.pdf)) | Only before the fire: knowing occupancy |
| Car crash | EU eCall, mandatory in new models since 31 March 2018 ([European Parliament](https://www.europarl.europa.eu/news/en/press-room/20180326IPR00510/saving-lives-ecall-mandatory-in-new-car-models-from-this-week)); in-cabin radar for child presence, scored by Euro NCAP from 2026 ([Smart Eye](https://smarteye.se/blog/what-euro-ncap-2026-says-about-child-presence-detection/)) | Built in by carmakers and their radar suppliers | No — closed automotive supply chain |
| Terrorist attack, hostage | Range-R ($6,000) and Xaver through-wall radar for police | Often sold only to police and military | No, and dangerous for the brand |
| Building evacuation | Wi-Fi connection logs showed floor-level occupancy across 14 buildings and detected 29 unplanned evacuations ([UNSW/IBM, IoTDI 2020](https://conferences.computer.org/cpsiot/pdfs/IoTDI2020-4iVfYvtS6skUwUrnhqFnZb/660200a116/660200a116.pdf)) | Research; counts phones, not people | **Yes** — Life-Fi senses bodies, phones or not |

**Weighted score** (1 = poor, 5 = strong; for risk, 5 = low risk; scores are the team's judgement from the research above)

| Option | Feasible on ESP32 (30%) | Need and budget (20%) | Gap vs competitors (15%) | Brand and privacy fit (15%) | Legal / ethical risk (10%) | Demo-able at hackathon (10%) | **Weighted score** |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Care: home, clinic (current) | 4 | 5 | 4 | 5 | 3 | 5 | **4.35** |
| Fixed sensors: occupancy snapshot for fire and earthquake responders | 4 | 3 | 3 | 4 | 4 | 4 | **3.65** |
| Portable: fire, people in smoke | 2 | 3 | 2 | 3 | 4 | 2 | **2.55** |
| Portable: earthquake rubble | 1 | 3 | 2 | 4 | 4 | 1 | **2.30** |
| Car crash, occupant detection | 2 | 2 | 1 | 3 | 3 | 2 | **2.10** |
| Terrorist attack, hostage, through-wall | 2 | 2 | 2 | 1 | 1 | 2 | **1.75** |

**Why the terrorist-attack option scores lowest.** Through-wall sensing for police drew court challenges and ACLU criticism in the US ([TechXplore, 2015](https://techxplore.com/news/2015-01-law-personnel-see-through-radar-tech.html)). EU dual-use export rules cover items for covert surveillance of people and add a catch-all for human-rights risk ([EP briefing on Regulation 2021/821](<https://www.europarl.europa.eu/RegData/etudes/BRIE/2023/754439/EXPO_BRI(2023)754439_EN.pdf>)); whether Wi-Fi sensing qualifies is unverified. Most of all, "see through walls for police" destroys the "no camera, privacy by physics" promise that sells Life-Fi to families.

**The Bulgarian angle that does work.** Bulgaria has real seismic risk: the 1977 Vrancea earthquake killed about 120 people in Bulgaria, mostly in three collapsed blocks in Svishtov ([Wikipedia](https://en.wikipedia.org/wiki/1977_Vrancea_earthquake)). The fire service (GDPBZN) sent 58 rescuers to Turkey in February 2023 ([Novinite](https://www.novinite.com/articles/218749/Bulgarian+Rescue+Team+of+the+Fire+Department+left+for+Turkey+from+Plovdiv)). A care home or school already fitted with Life-Fi could hand responders a list: *room 12, one person, last moved 40 s before the alarm, breathing normal.* That reuses the same sensors and fits the brand.

**How to use this in the pitch**

- Keep it to one "vision" sentence near the end: "The same sensors that watch over Mara at night can tell firefighters which rooms still had people in them."
- Don't demo or promise rubble, car or hostage detection. A judge with rescue or radar knowledge will see through it.
- If asked about earthquakes: "Finding people under rubble needs radar like NASA's FINDER. Our part is knowing who was in the building before it happened."
- Possible later feature: an "emergency snapshot" export from the Clinic and School profiles, sent with the fire alarm. It needs a battery backup and a local copy, because power and Wi-Fi fail in a disaster.

## Recommendations and next steps

Position Life-Fi as **the safety net for people who won't wear one**, lead with Home, prove it in a care home, and never claim more than you measured.

- [ ] Pick one tagline and use it on every slide, the dashboard and the repo README.
- [ ] Lead the pitch with the Fleming & Brayne finding: 80% of alarm owners did not use their alarm when they fell.
- [ ] Put the honest-limits slide in the pitch; show fall recall and false alarms per hour with confidence intervals.
- [ ] Use "assistive notification, not a medical device" on the dashboard, slides and README.
- [ ] Add the second ESP32 node (\~€10) before the final demo: the cheapest big improvement in coverage and false alarms.
- [ ] Test false alarms against pets, robot vacuums, dropped bags and hard sit-downs.
- [ ] Check the "Life-Fi" trademark and domain; prepare to explain the difference from Li-Fi.
- [ ] Contact one care home or Varna's home-patronage service about a small consented pilot.
- [ ] Ask a regulatory advisor whether breathing alerts make it a medical device under EU MDR.
- [ ] Make a one-page leaflet for families and a separate one for care homes: different buyers, different words.

* [ ] Add one vision sentence on the "emergency occupancy snapshot" for fire and earthquake responders; do not demo or promise rubble, car-crash or hostage detection.

**Open questions**

- Will judges score business viability or only technology? This changes how long the business part of the pitch should be.
- Can a care home in Varna be reached before the event for a quote or letter of interest?

**Sources** (opened 2026-10-06; market sizes are commercial estimates)

- WHO, [Falls fact sheet](https://www.who.int/news-room/fact-sheets/detail/falls)
- Montero-Odasso et al., [World Falls Guidelines, Age and Ageing 2022](https://academic.oup.com/ageing/article/51/9/afac205/6730755)
- University of Sheffield, [Long Lies Study](https://sheffield.ac.uk/cure/current-trials/long-lies-study)
- Fleming & Brayne, [Inability to get up after falling, BMJ 2008](https://pmc.ncbi.nlm.nih.gov/articles/PMC2590903/)
- EuroSafe/EUPHA, [Falls in older adults in the EU](https://db.eupha.org/repository/sections/ipsp/Factsheet_falls_in_older_adults_in_EU.pdf)
- Eurostat, [Population structure and ageing](https://ec.europa.eu/eurostat/statistics-explained/index.php?title=Population_structure_and_ageing); [Older people living alone, 2020](https://ec.europa.eu/eurostat/web/products-eurostat-news/-/DDN-20200623-1)
- NSI Bulgaria, [Population 2024](https://www.nsi.bg/en/file/28604/Population2024_en_F59F6N4.pdf)
- Sofia Globe, [2021 census results](https://sofiaglobe.com/2022/10/03/bulgarias-2021-census-final-results-confirm-large-drop-in-population/)
- OECD/EC, [Bulgaria Country Health Profile 2025](https://www.oecd.org/content/dam/oecd/en/publications/reports/2025/12/country-health-profile-2025-country-notes_7e72146d/bulgaria_242bb908/cd5706eb-en.pdf)
- Grand View Research, [PERS market](https://www.grandviewresearch.com/industry-analysis/medical-alert-personal-emergency-response-system-pers-market); [Fall detection market](https://www.grandviewresearch.com/industry-analysis/fall-detection-systems-market-report)
- Straits Research, [Ambient assisted living market](https://straitsresearch.com/report/ambient-assisted-living-market); MarketIntelo, [Wi-Fi sensing market](https://marketintelo.com/report/wi-fi-sensing-market)
- European Commission, [MDCG 2019-11 Rev.1 software guidance](https://health.ec.europa.eu/document/download/b45335c5-1679-4c71-a91c-fc7a4d37f12b_en?filename=md_mdcg_2019_11_guidance_qualification_classification_software_en.pdf); [GDPR Art. 9](https://gdpr-info.eu/art-9-gdpr/); [AI Act Art. 5](https://artificialintelligenceact.eu/article/5/), [Art. 6](https://artificialintelligenceact.eu/article/6/)
- IEEE, [802.11bf-2025 WLAN Sensing](https://standards.ieee.org/ieee/802.11bf/11574/)
- Competitors: [Medical Guardian vs Life Alert](https://www.seniorliving.org/medical-alert-systems/medical-guardian-vs-life-alert/); [Apple fall detection](https://support.apple.com/en-us/108896); [Aqara FP2](https://us.aqara.com/products/presence-sensor-fp2); [Kepler Vision FAQ](https://keplervision.eu/en/frequently-asked-questions/); [Cognitive Systems](https://www.cognitivesystems.com/); [Linksys end of life](https://www.linksys.com/pages/linksys-product-end-of-life); [ESPectre](https://github.com/francescopace/espectre); [Origin/ADT field study, arXiv 2506.04322](https://arxiv.org/abs/2506.04322)
- Project docs: `docs/plan-v2.md`, `docs/csi-sufficiency-research.md`
