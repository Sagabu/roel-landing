// Script for å importere FKF-dommere fra tabellformat
// Kjør med: node import-dommere.js

const Database = require('better-sqlite3');
const db = new Database('./fuglehund.db');

// Funksjon for å normalisere telefonnummer til 8 siffer uten landskode
function normalizePhone(phone) {
    if (!phone || phone.trim() === '') return null;

    // Ta første nummer hvis det er flere (separert med - eller ,)
    let firstPhone = phone.split('-')[0].split(',')[0].trim();

    // Fjern alle ikke-numeriske tegn
    let digits = firstPhone.replace(/\D/g, '');

    // Fjern landskode 47 fra starten hvis den finnes
    if (digits.startsWith('47') && digits.length > 8) {
        digits = digits.substring(2);
    }

    // Returner kun hvis vi har 8 siffer
    if (digits.length === 8) {
        return digits;
    }

    return null;
}

// Parse tabelldata
const rawData = `Abel-Lunde, Arne|Ulaveien 78|3280 Tjodalyng|4797744245|abellunde@gmail.com
Alm, Ørjan|Tangodden 1|8253 Rognan|+4797028559 - +4797028559|orjan.alm@signalbox.no
Amundsen, Rune Andre|Sundvegen 803|5379 Steinsland|4740234904|rune.andre.amundsen@gmail.com
Andersen, Oddgeir|Vargstadvegen 43B|2619 Lillehammer|4793466706|oan@nina.no
Andersen, Pål Kristian|Tunvollveien 60|3057 Solbergelva|4790783869|pkan@lier.kommune.no
Andersen, Sverre Ragnar|Bjørklia 18|9300 Finnsnes|+4745276331 - +4798265196|serrea@online.no
Arnesen, Lars Ådne|Fosslandsvegen 115|7870 Grong|4799042468|lars@sarabakk.no
Aspenes, Pål|Solstrandveien 141|9020 Tromsdalen|+4777694108 - +4795849330|paaspe@online.no
Austvik, Torbjørn|Gabriel Vollans Veg 1|7072 Heimdal|4791705200|to-aus@outlook.com
Berg, Per-Anton|Boks 107|9252 Tromsø|+4790042000 - +4790042000|per.anton@icloud.com
Berger, Øivind|Sætermoveien 109|9309 Finnsnes|4794881236|berger.ib93@gmail.com
Berget, Dag Arne|Muggoppvegen 11|2430 Jordet|4791540558|dag.berget@gmail.com
Berntsen, Arnfinn|Kongsvegen 68B|2380 Brumunddal|4796232888|arnfinn.berntsen@gmail.com
Berntsen, Bård Sigve|Kopparleden 4195|2448 Sømådalen|4791539883|baard.sigve@hotmail.no
Bjerke, Elisabeth Haukaas|Kantvegen 68B|2618 Lillehammer||elisabeth.haukaas.bjerke@glor.no
Bjugan, Terje|Ogndalsvegen 1577|7718 Steinkjer|4741557163|tebjugan@online.no
Bjørklund, Øyvind|Islosveien 15|9910 Bjørnevatn|4748105490|oyvind.bjorklund@ffk.no
Bjørn, Andreas|Leirfallveien 5|8613 Mo I Rana|4790544179|abjoer5@online.no
Bjørn, Frank Gunnar|Finnhvalveien 46|9100 Kvaløysletta|4748139415|frank.bjorn@bjorn.no
Bjørndal, Magne|Dåfjordvegen 157|5410 Sagvåg|+4753499760 - +4741561683|magne.bjorndal@yahoo.com
Boneng, Bjørnar|Nordengvegen 4|7608 Levanger|+4746400956 - +4790060484|bjornar.boneng@kvaerner.com
Borcherding, Andreas|Hegglandsdalsvegen 694|5211 Os|4799201213|andreas@borgenbetong.no
Borgen, Svein|Gravliveien 49|3719 Skien|4790041700|sveborge@online.no
Bowitz, Jørn Gunnar|Grastveitveien 62|4372 Egersund|4795766885|kennelpointmann@gmail.com
Bratberg, Olav Margido|Brattbergsvegen 109|7730 Beitstad|4799262005|o-mbra@online.no
Brekke, Per Ola|Gamle Kongsbergv. 4|3322 Fiskum|4792417672|bolt7@live.no
Brenden, Robert Mansverk|Prestadalen 3|6856 Sogndal|4790962909|robert.brenden@presisvegdrift.no
Brenden, Roger|Bråtelia 69|2410 Hernes|4791746747|rogbre97@gmail.com
Brenna, Rune Olav|Skjulstadvegen 378|2100 Skarnes|4795053957|runeolavbrenna@gmail.com
Børmark, Sindre|Rådyrvegen 2|7970 Kolvereid|4790724348|sindre_bby@hotmail.com
Baardvik, Bjørn Morten|Langsundveien 1443|9130 Hansnes|4795210535|bmbaar@gmail.com
Bårseth, Jan Terje|Uthusvegen 52|7580 Selbu|4797710008|janterjeb@gmail.com
Carlsen, Rune|Stensrudvegen 30|2760 Brandbu|4795778511|rune.carlsen@mcarlsen.no
Colbjørnsen, Robert|Myragata 19|3512 Hønefoss|4741263340|robcol@online.no
Dahl, Arild|Tyttebærvegen 9|7606 Levanger|4799367737|bukkafjellet@gmail.com
Dahl, Øystein|Blakersundveien 5|1923 Sørum|4745423223|hogdalia@gmail.com
Dahl, Øystein Heggelund|Nordseterveien 22|1176 Oslo|4797198216|ohd@uniconsult.no
Dahl-Stamnes, Øivind Andreas|Myklabergveien 8|4314 Sandnes|4795211986|oivind.dahl-stamnes@lyse.net
Dyrstad, Ola Helge|Straumfjord Vest 640|9157 Storslett|4797668318|reisarypa@gmail.com
Døsvik, Frode|Småaunvegen 35|7232 Lundamo|4740043320|frodedos@gmail.com
Edvinsen, Stig Even|Gjerdhaugen 20|8050 Tverlandet|4797093219|stig.e.e.75@gmail.com
Eliassen, Einar Bernhard|Alternesveien 13|8616 Mo I Rana|+4775153969 - +4748158576|einar.eliassen@sbh.no
Eliasson, Torbjørn|Munkebyvegen 147|7608 Levanger|4790170094|torbjorn.eliasson@hnt.no
Enberget, Kjell|Gruveveien 14|3614 Kongsberg|+4732987670 - +4797603072|kjell.enberget@ebnett.no
Engen, Bjarne|Lundadalsvegen 72|7232 Lundamo|4790973281|bjarneengen4@gmail.com
Engh, Thomas|Langehaugvegen 11|3580 Geilo|4794890223|thomasengh71@gmail.com
Enoksen, Hans Einar|Åsveien 30|8520 Ankenes|4792404764|henoksen@hotmail.com
Eriksen, Steffen|Brauta 22|7091 Tiller|4795216636|s74@tbrt.no
Eriksen, Øyvind|Presthaugveien 8|7900 Rørvik|+4774391072 - +4795847667|oeyvier2@online.no
Fagermo, Dagfin|Skeiddalen 28 C|8070 Bodø|4797502311|dagfin.fagermo@hotmail.com
Fløymo, Ulf Henning|Strandbygdvegen 656|2411 Elverum|4790171588|ulffloymo61@gmail.com
Foss, Per Gudmund|Manganveien 1|4629 Kristiansand S|4798483642|pergudmund.foss@skatteetaten.no
Frankmoen, Rune|Tåsåsveien 430|2320 Furnes|4748105588|frankmovangens@gmail.com
Fredheim, Knut|Botnlia 39|9303 Silsand|4740029610|knfredheim@gmail.com
Frenning, Ingrid|Mølneringen 34|9104 Kvaløya|4741414778|ingrid.frenning@uit.no
Friis, Pål|Lumbertoppen 31|4621 Kristiansand S|+4738011282 - +4741658030|friispaal@gmail.com
Gill, Robert Karsten|Korvaldveien 135|3050 Mjøndalen|4790935352|robertkgill@hotmail.no
Gisvold, Elisabeth|Jonsvannsveien 17|7052 Trondheim|+4790615584 - +4790615684|elisabeth.gisvold@gmail.com
Glad, Geir Arne|Ramnvn 13|8665 Mosjøen|+4775173989 - +4799791666|geir.arne.glad@gmail.com
Glørstad, Rune|Heggbakken 3|7550 Hommelvik|4740494378|runeglorstad@hotmail.com
Grindstuen, Knut Ole|Grubbegata 11|2630 Ringebu|4741210416|k_grindstuen@hotmail.com
Gudim, Lone|Ringstadhavna 20|1667 Rolvsøy|+4792435771 - +4746317803|lone.gudim@gmail.com
Gundersen, Gunnar|Gamle Trondheimsvei 50|1481 Hagan|4795128750|kennelutennavn@gmail.com
Hagen, Ole Magnus|Skogvegen 30 a|2072 Dal|4748164272|olehagen30@gmail.com
Hagen, Terje|Solevegen 90|2322 Ridabu|+4762531491 - +4795182518|terje.n.hagen@outlook.com
Hallås, Per Sverre|Hamnbuktveien 102|9700 Lakselv|+4747315066 - +4747315066|per.hallas@yahoo.no
Halvorsen, Bernhardt|Moan 31|9357 Tennevoll|+4777175239 - +4791660741|bernbygg@lavangen.net
Halvorsen, Randi|Kallerudvegen 475|3628 Veggli|4793414531|ranhalvo@online.no
Hamre-Hagen, Stian|Raneisvegen 112|2900 Fagernes|4795086489|hagen_stian@hotmail.com
Hansen, Kjell Otto|Horrvikvegen 86|6620 Ålvundeid|4790870042|kjellh24@gmail.com
Hansen, Stig-Håvard Skain|Heggbakken 2|7550 Hommelvik|4791513801|stihha@online.no
Hansen, Svein Oddvar|Nedbergkollveien 43|3050 Mjøndalen|4791138614|sveinod.hansen@gmail.com
Hanssen, Mads Oddvar|Sandvikveien 132|9300 Finnsnes|+4777849398 - +4792880276|madshan@online.no
Hartviksen, Ronny|Toppen 3|9321 Moen|4799504081|ronny.hartviksen@asko.no
Haug, Eigil|Strønevegen 34|5217 Hagavik|56305671 - 47949117|eigil-haug@hotmail.com
Hauge, Kurth|Kjelde 18|8543 Kjeldebotn|4748119960|khauge57@gmail.com
Haugen, Geir Evju|Brastadveien 5|3403 Lier|+4732852714 - +4798243780|geir.haugen@lifi.no
Haugen, Jan Terje|Anleggsvegen 189|2647 Sør-Fron|4797538999|jan@tiller-vimek.no
Haugen, Magnus|Muruvikvegen 14|7550 Hommelvik|4797415628|mh@allskog.no
Heggdal, Roar|Mølnåvegen 148|7750 Namdalseid|4795245676|heggisman@hotmail.com
Helgemo, Jan Erik|Mosløkkja 23|7232 Lundamo|4791393458|
Henriksen, Edgar|Åslandvegen 81|9105 Kvaløya|4790578325|edgarhen@online.no
Henriksen, Stian|Sikdalsveien 12B|9910 Bjørnevatn|4795528103|stianhenriksen0@gmail.com
Herje, Brian Johan|Sjøvollvegen 3A|7725 Steinkjer|4797969269|Brian.herje@gmail.com
Hermansen, Birger Grøndahl|Kirkegrenda 7|1580 Rygge|4795088866|birger.hermansen@gmail.com
Hermanstad, Roger|Jonsvannsveien 565|7057 Jonsvatnet|4790951149|roger.hermanstad@nbt.no
Hestad, Stein Olav|Lunheimveien 9|6416 Molde|90729560 - +4790729560|stein.hestad@gmail.com
Hestmo, Ole Andre|Lægdgrinda 10|7026 Trondheim|4748124501|hestmo@gmail.com
Hetlevik, Anders Eide|Skutlevika 4|5314 Kjerrgarden|4795046023|aehtjenester@gmail.com
Hoholm, Rune|Brygghaugveien 320|9303 Silsand|+4791335546 - +4791335546|ruhoholm@gmail.com
Holand, Tore|Skippergata 24|7900 Rørvik|74391176 - 91735342|tor.hol@outlook.com
Holden, Pål Morten|Orrhanevegen 16|2032 Maura|4799092513|paalholden@hotmail.com
Holmseth, Ørjan|Hølondvegen 356|7224 Melhus|+4793015408 - +4790194291|orjan.holmseth1989@gmail.com
Hovde, Arne|Bugjelet 2|7760 Snåsa|+4791327755 - +4791327755|arne.hovde@gmail.com
Høvde, Per Erling|Venstad 3|9325 Bardufoss|+4777833019 - +4790740288|p-e-hoev@online.no
Høvik, Kurt|Dalabakkan 18|7550 Hommelvik|4741542088|kurthovik@gmail.com
Håheim, Reidar Arvid|Kræmmervikveien 30|8373 Ballstad|4795934906|rhaahei@online.no
Indset, Terje|Fremovegen 419|7234 Ler|4741518267|terje.indset@gmail.com
Ingebrigtsen, Ole Espen|Åsvegen 31|9020 Tromsdalen|4791575666|ole@dgruppen.no
Ingebrigtsen, Torgeir|Hagavegen 39E|9007 Tromsø|4741624747|torgeir.ingebrigtsen@consto.no
Jacobsen, Kjell|Ronatoppen 59|4638 Kristiansand S|4791186308|kjell.jacob@gmail.com
Jensen, Morten Charles|Åsvegen 219|2033 Åsgreina|4797026853|moch-j@online.no
Jenssen, Jostein|Notveien 9|8520 Ankenes|4748145700|jj@jenssenogbolle.no
Jetmundsen, Helen|Trollien 6|5101 Eidsvågneset|4741144343|helenjetm@gmail.com
Johansen, Bård-Helge|Durmålsvegen 30|9101 Kvaløysletta|4741436863|bard_helge@hotmail.com
Johansen, Edgar|Saursveien 70|8283 Leinesfjord|+4775778266 - +4748006468|edga-joh@online.no
Johnsen, Øystein|Hegglandsdalsvegen 756|5211 Os|4797176169|oystein@grunn-betong.no
Johnson, Lars Espolin|Fjellveien 20|8012 Bodø|4748238400|larsej86@gmail.com
Jonassen, Cato Martin|Øversjødalen 136|2544 Øversjødalen|4791385989|catomartin@icloud.com
Jørgensen, Karl Ole|Lomveien 68|8516 Narvik|4799391152|karl.ole.jorgensen1960@gmail.com
Jørgensen, Ulf Thorstein|Rødsbakkene 30|3480 Filtvet|+4732791800 - +4791651100|ulfthorsteinjorgensen@gmail.com
Kallekleiv, Tore|Ponstivegen 7|5551 Auklandshamn|4747262607|rugdelias@gmail.com
Kanestrøm, Tone|Turistvegen 23|9020 Tromsdalen|4790633229|rypetone@gmail.com
Karlsen, Jørn-Tore|Lineveien 4|9515 Alta|4797114391|jorn-tore.karlsen@hotmail.com
Karlsen, Roar|Solløkkaveien 12|3233 Sandefjord|4795216331|roar@iata.no
Karlsen, Øyvind|Myravn 23|8622 Mo I Rana|+4799237872 - +4747039275|oyvind.karlsen@sbh.no
Kirkhus, Kjetil Vikeså|Auglandsveien 25|4827 Frolands Verk|4797538311|Kjetil_Kirkhus@hotmail.com
Kittilsen, Sven-Tore|Gregorius Dagssons Gate 6|3746 Skien|+4799159941 - +4799159941|sve-k@online.no
Kjølstad, Svein Erik|Lonbakkvegen 19|7877 Høylandet|4741438357|svein_erik_kjolstad@hotmail.com
Klemetsdal, Jarle|Rypeveien 33|3420 Lierskogen|+4732851226 - +4799447732|jklemets@online.no
Klingan, Ole Morten|Øyåsbakken 15|9103 Kvaløya|4791809497|okli@frisurf.no
Kolstad, Trond Erik|Lysthaugvegen 20|7657 Verdal|+4790845470 - +4791791129|rype2014@gmail.com
Kolsum, Kari|Bastemyra 7|7520 Hegra|4795056087|karikhofstad@gmail.com
Kongsdal, Arne Kristian|Stordalsvegen 4|8664 Mosjøen|4748024750|akon601@hotmail.com
Kristiansen, Alexander|Folkvordveien 171|4318 Sandnes|+4751623996 - +4747394955|alexanderkristiansen71@gmail.com
Kristiansen, Audun|Nordhagenvegen 43|3712 Skien|+4735546627 - +4791841655|audun.kristiansen@veidekke.no
Kristiansen, Kjetil|Oslikroken 21|4336 Sandnes|4790647638|kjetil.kristiansen@varenergi.no
Kvam, Lasse|Revefarmen 51|3033 Drammen|+4731291949 - +4795288684|lasse.kvam@mtee.no
Kvåle, Svein|Gamle Kroervei 83|1435 Ås|4792622225|Svein.Kvale@me.com
Larsen, Camilla Mostrøm|Nordre Sprovei 44|1454 Fagerstrand|4791146490|cs-as@outlook.com
Larsen, Jan Atle|Goemyr 10|4324 Sandnes|4797187473|oddresteinen@gmail.com
Larsen, Ragnar|Ivar Aasens veg 1|2407 Elverum|4799506651|ragnar-larsen@hotmail.com
Larsen, Samuel|Øvre Hunsdalsvei 192|4534 Marnardal|4790181666|samla@vabb.no
Leiros, Ingar|Jarsteinen 15B|9017 Tromsø|4795966895|ingar.leiros@uit.no
Lie, Tore|Gamle Åsvegen 50|2034 Holter|4790203313|tore-li3@online.no
Lien, Tord Erik|Trommaldvegen 37|3539 Flå|4791171461|ringdyr@online.no
Lillegård, Edvard|Engliveien 13|8610 Mo I Rana|+4775130975 - +4741230339|edvard.lillegaerd@gmail.com
Lindbøl, Kjartan|Bleiksarhlid 11 735 Eskifjordur||4795909675|turbokjartan@hotmail.com
Lindtvedt, Jørn Kristian|Hedenstadveien 137|3619 Skollenborg|4795270739|jornkristian.lindtvedt@gmail.com
Loe, Henning|Vestre Rosten 32B|7072 Heimdal|4799377632|henning.loe@gmail.com
Lunde, Anders Jan|Lekvenvegen 21|5209 Os|+4795129290 - +4797025123|anders.j.lunde@gmail.com
Lundevik, Njaal Edwin|Lundeviksveien 191|4513 Mandal|+4738269612 - +4751351060 - +4793482438|njaal.lundevik26@gmail.com
Lunne, Espen|Huldrevegen 3|4365 Nærbø|92425465 - 51799105 - 92425465|esplunne@gmail.com
Lyngar, Mikkel Sinclair|Brattbakken 5|8079 Bodø|4790944523|s-lynga@online.no
Lyngroth, Torfinn|Lyngrothveien 294|4820 Froland|+4737037068 - +4790938875|tolyngr@online.no
Lysgård, William Finnanger|Olav Duuns Veg 29|7804 Namsos|4795206209|william.lysgard@gmail.com
Løken, Morten|Setervikveien 7|1925 Blaker|4790773188|morten.breton@gmail.com
Magnussen, Rune Andre|Kallerudvegen 475|3628 Veggli|4793416010|runamag@online.no
Maliberg, Kjell Roger|Trangsrudsroa 125|2270 Flisa|4795066705|kjroma@outlook.com
Martinsen, Anders|Jarenveien 32B|1340 Skui|4790013292|byggmester.martinsen@gmail.com
Melby, Iver|Industrivegen 7|2836 Biri|4795880014|ivemel@online.no
Meldal, Hege|Midnattssolveien 1046|8016 Bodø|4791154152|hege.meldal@nord.no
Meås, Jøran Dyrvik|Nedre Nygård 17B|1482 Nittedal|4799514740|joranmeas@gmail.com
Midtsveen, Stian|Steinsrudmoen 21|2920 Leira I Valdres|+4761362489 - +4797411072|stian-mi@online.no
Mikalsen, Rune|Skulgamvegen 574|9131 Kårvik|4790532724|rune@scanfish.no
Moe, Åsgeir|Myrkroken 13|7970 Kolvereid|4799269947|aasgeim@online.no
Moen, Stig|Haukvegen 15|2406 Elverum|4795135665|stig.moen@hotmail.com
Myrhaug, Ulrik|Grindaveien 14|3090 Hof|4791698725|ulrik@elceta.no
Mæhla, Tore|Åsveien 156|7530 Meråker|4793226972|fagermoa@fagermoa.com
Møllerop, Mette|Madlaforen 44|4042 Hafrsfjord|4795735710|metmoel@online.no
Mørk, Knut Edward|Andøysløyfen 134|4623 Kristiansand S|4791867308|knut.e.mork@gmail.com
Natland, Terje|Boks 22|5486 Rosendal|4799574121|terje.natland@knett.no
Nedrebø, Rune|Frænavegen 430|6423 Molde|4790839532|rune@nedrebo.com
Nedrejord, Ola Lunden|Eidsvegen 13|4230 Sand|4791525513|ola.nedrejord@norsk-stein.no
Nilsen, Reidar|Fenesveien 105|8020 Bodø|4747238548|reidar.nilsen@haaland.no
Nilsen, Øystein|Greisdalsveien 81|8028 Bodø|+4775518365 - +4790617712|oeysnil2@online.no
Nilsen, Åge|Kattmarkveien 53 Namsos|7802 Namsos|+4774274754 - +4797086174|agenilsen327@gmail.com
Nilssen, Sten|Kirkeveien 15|9300 Finnsnes|4790603526|malgosia001@hotmail.com
Nordnæs, Hans Arne|Nossvegen 316|3570 Ål|4793250797|hans.nordnaes@gmail.com
Norum, Kåre|Fridheims gate 28|7650 Verdal|4790045243|kaare.norum@icloud.com
Nyborg, Sigmund|Olaf Molbergsvei 10D|7892 Trones|+4799354886 - +4799354886|noraforr@online.no
Nynes, Kjell Morten|Skogstien 27|7804 Namsos|+4774404540 - +4795964999|nynesfjell@hotmail.com
Oksås, Odd Joar|Eliløkken 4|7353 Børsa|4795427045|oddjoar72@gmail.com
Olaussen, Åge|Kløverbakken 15|2208 Kongsvinger|4790940316|ageolaussen12@gmail.com
Olsen, Eirik Magne|Langstrandveien 12|9130 Hansnes|4799558070|eirik.m.olsen@icloud.com
Olsen, Trond Egil|Vestbygdvegen 257|2312 Ottestad|4790900173|fuglehundsenteret@hotmail.com
Olstad, Øyvind|Uthusvegen 2|3580 Geilo|4798012882|olstad@ntg.no
Osberg, Lene|Rugdeveien 1F|4318 Sandnes|4746953966|leneosberg@gmail.com
Pedersen, Skjalg|Strandabøfjøra 24|6065 Ulsteinvik|4791123145|skjalgpedersen@gmail.com
Petterson, Ole Jens|Ingstadveien 385|7520 Hegra|4799247541|Olepetter32@gmail.com
Plassgård, Tor Espen|Solbergveien 72 B|2020 Skedsmokorset|4791309773|torespen6@msn.com
Presterudstuen, Jørn|Yksetvegen 116|2388 Brumunddal|4799007834|jorpre@me.com
Reidarsen, Roy|Gregorius Dagssons gate 81|3746 Skien|+4735502538 - +4791683053|r-reid@online.no
Remmen, Ottar Magne|Høgegga 17|9151 Storslett|4792820744|ottar.remmen@gmail.com
Ribesen, Øyvind|Skarvet 47|5770 Tyssedal|4797498943|oyvind.ribesen@bohus.no
Riise, Morten|Åsveien 16|9910 Bjørnevatn|4791158661|mriise68@gmail.com
Risdal, Frode|Hytteveien 24|9409 Harstad|4790024058|frode.risdal@harstad.kommune.no
Risstad, Morten|Jonsvannsveien 17|7052 Trondheim|4797166263|morten.risstad@gmail.com
Rudi, Håvard Otto|Sagdalsvegen 337|2672 Sel|4790064231|havard@rsbygg.no
Rødsjø, Halvar|Sørfjordveien 484|7113 Husbysjøen|4795203982|hal-roe@online.no
Rødsjø, Ingvar|Gaukesvingen 15|7160 Bjugn|4741660482|ingvar.rodsjo@gmail.com
Rødsjø, Tormod|Aundalsveien 23|7160 Bjugn|4793012638|tormod.rodsjo@live.no
Røe, Pål Inge|Karlgardsvegen 102|7660 Vuku|+4741223569 - +4795844365|spjeldberget@gmail.com
Røed, Tore Chr.|Ovenstadveien 40|3420 Lierskogen|91852241|torecroed@gmail.com
Rønning, Ola|Haraldhaugvegen 5|7563 Malvik|+4773591078 - +4773977105 - +4792619846|olaron59@gmail.com
Rørstad, Sven Kyrre|Bjørnhullvegen 25|3917 Porsgrunn|4799251687|kyrre.rorstad@gmail.com
Raastad, Ingun|Lindstadvegen 23|2750 Gran|4790144683|ingun_raastad@hotmail.com
Sagberg, Lars Olav|Henrik Mathiesens Vei 14|7015 Trondheim|4790506940|larssagberg61@gmail.com
Sagland, Thor Bernhard|Jernvegen 10b|4755 Hovden I Setesdal|+4751497039 - +4793468608|thbernha2018@outlook.com
Sagmo, Ronny|Branesvegen 15|7606 Levanger|4740061255|ronnysagmo@gmail.com
Sagør, Jens Thomas|Alexander Kiellands Gate 1|7015 Trondheim|+4773942662 - +4799523886|jenssagor@gmail.com
Samdal, Terje Strickert|Tyholtveien 52B|7052 Trondheim|4790674905|terje.samdal@online.no
Sandanger, Per Gunnar|Rebakken 43|4028 Stavanger|+4751542778 - +4790874947|per.sandanger@gmail.com
Sandsør, Bernt Martin|Snurruvegen 2|7550 Hommelvik|4798207754|bernt.sandsor@gmail.com
Schei, Geir|Brattbakkveien 201|8664 Mosjøen|4791753887|mgbilas@gmail.com
Schjølberg, Bjørn|Øra 19B|7374 Røros|4791544407|bjorn@roroskulde.no
Schjølberg, Espen|Bjerkejordet 28|1350 Lommedalen|4798215151|espen.schjolberg@hotmail.com
Schrøder, Olav Andreas|Telemarksveien 259|4985 Vegårshei|4795701685|olav@lytingfjellets.com
Schulze, Randi|Tumyrveien 12|1482 Nittedal|4795101753|randi@hunderifokus.no
Seljesæther, Christell Hoftaniska|Sikdalsveien 12B|9910 Bjørnevatn|+4790041356 - +4790041356|christellseljesether@gmail.com
Sellie, Svein|Ukjent adressJørgen Hegstads veg 22|7089 Heimdal|4798646447|s-sellie@online.no
Simensen, Hans Walen|Grønland 70C|3045 Drammen|+4732855559 - +4792039490|hans@bergans.no
Simensrud, Anders|Badeveien 40|3370 Vikersund|4740841501|simand@banenor.no
Simonsen, Børge Torstein Harald|Vatnedalsveien 71|4516 Mandal|+4751979502 - +4798841053|simonborge@yahoo.no
Sjurseth, Bjørn|Bamse Brakars Vei 38|3042 Drammen|4791646862|bjornsjur@gmail.com
Skaret, Roy Allan|Kvalvågdalen 66|6525 Frei|4795057101|postmaster@royalura.com
Skarsvaag, Bernt Otto|Huldervegen 117|7056 Ranheim|4797983242|berntos@gmail.com
Skatland, Roger|Søndre Gate 37 B|8624 Mo I Rana|4799436416|rs@momek.no
Skaug, Frank Petter|Aurbergmoen 137|2160 Vormsund|4795748886|petskaug@gmail.com
Skeie, Rune|Skeisleira 5|5217 Hagavik|+4756302953 - +4793464915|runeskeie1972@gmail.com
Skeivik, Arild|Andrew Smiths Gate 2|4024 Stavanger|+4790803667 - +4790803667|arsk@ows.no
Skiple, Knut Steinar|Hjellane 32|5705 Voss|4791576672|knuski57@gmail.com
Skogli, Steinar|Olshågveien 3|8178 Halsa|4794185563|s-skogl2@online.no
Skrefsrud, Jan Gustav|Slettumvegen 12|2390 Moelv|4791749794|jan.skrefsrud@gmail.com
Skurdal, Øivind|Åsstuevegen 29|2618 Lillehammer|4797592180|os@fjossystemer.no
Skaar, Nils Brandtzæg|Brages Veg 12A|7602 Levanger|4797719495|Nilsbskaar@gmail.com
Sletbakk, Christian|Sørsiveien 131|9310 Sørreisa|4747896036|christian@kontordesign.no
Slommerud, Erik|Tangen 8|1676 Kråkerøy|4797698999|erikslommerud@gmail.com
Smemo, Jostein|Sivert Thonstads vei 8D|7072 Heimdal|+4797747295 - +4797747295|Jostein.smemo@allskog.no
Solheim, Bjørn Willy|Roaveien 30|3534 Sokna|4797704444|bjsolhe3@online.no
Sollid, Ketil|Blåskjellveien 19|9414 Harstad|4797093467|ksollid67@gmail.com
Soma, Tom|Sjoaberget 3|4308 Sandnes|4794847655|tom.soma@lyse.net
Sorknes, Stein Arne|Finnskogvegen 2515|2256 Grue Finnskog|4797956604|stein.arne.sorknes@gmail.com
Sparboe, Maria|Magnus Blindes Veg 12B|7052 Trondheim|4790835353|maria@sparboe.net
Sperre, Jan Erling|Blindheimsneset 14|6020 Ålesund|+4792085183 - +4792085183|jan.sperre@outlook.com
Staddeland, Rune Halvorsen|Kvanvikveien 300|4404 Flekkefjord|4791875777|run-stad@online.no
Staurset, Henning|Auretunveien 32|6408 Aureosen|4790554828|henning.staurset@hotmail.com
Steen, Petter|Åsvegen 811|2032 Maura|4741664088|valera@online.no
Steenland, Marianne Ølstad|Strømsåsveien 194|2500 Tynset|4791105898|mariannesteenland@gmail.com
Steigedal, Tor|Ingebrigtveien 6|6410 Molde|4791164147|tor.steigedal@gmail.com
Stenersen, Torfinn|Ormbakkvegen 14|2670 Otta|4790551701|torfinn.stenersen@sel.kommune.no
Stenmark, Geir Ove|Ripnesveien 43|8056 Saltstraumen|4799104002|harodalen@hotmail.com
Stensland, Geir Rune|Buveien 125|8521 Ankenes|4790404102|grstensland@gmail.com
Strige, Roland Alexander|Hagelstrøms Gate 23|9960 Kiberg|4797730119|roland_bois@hotmail.com
Strøm, Geir Henning|Løksmyra 72|7540 Klæbu|4746778335|geirhenningstrom@gmail.com
Strøm, Tom Roger|Breimoveien 29|8665 Mosjøen|4799574163|tomrstrom@hotmail.com
Strømsli, Ole Arnstein|Solbakkan 12|7170 Åfjord|4791833141|ol-arnst@online.no
Stuvland, Frank|Knausen 17|8664 Mosjøen|+4775186314 - +4799235015|Frank.stuvland@fellesforbundet.org
Stømner, Per Olai|Hummeldalsvegen 2 B|2414 Elverum|+4762411112 - +4791127847|o.pe@online.no
Størseth, Roger|Bakerovnsberget 42|1353 Bærums Verk|4740556427|roger_storseth@hotmail.com
Suleng, Tor|Baksidevegen 1250|2647 Sør-Fron|+4761298592 - +4791712118|tosule@online.no
Svare, Iver|Hellingvegen 17|3579 Torpo|+4732083444 - +4790036340|isvare@online.no
Sverdrup, Geir|Engerdalsveien 1679|2440 Engerdal|4791801148|gsverdr@gmail.com
Sveva, Gisle Kristian|Skiskogveien1|3474 Åros|+4793011061 - +4746426640|gisle@skiskogen.no
Svinsås, Asle|Orkdalsveien 1517|7327 Svorkmo|4797032122|asle@univernsenter.no
Syversen, Bjørn Tormod|Busveien 3|9910 Bjørnevatn|4745466175|btsyversen@gmail.com
Sæthereng, Fredrik Engell|Tinghaugveien 632|3175 Ramnes|4792613852|fredrik@engellhundesenter.no
Søgaard, Bjarte|Furusetvegen 30 B|3580 Geilo|+4732088045 - +4797659333|bjarte.soegaard@ntg.no
Søreng, Steffen Endresen|Hellearmen 1 B|4052 Røyneberg|4741507319|steffen.soreng@yahoo.no
Sørli, Leif Jan|Skjelbuktveien 32|6525 Frei|4792663907|leif.jan.sorli@me.com
Tagestad, Tore|Fiolveien 3|2647 Sør-Fron|+4761296889 - +4797568744|toretagestad59@gmail.com
Telhaug, Jan Arel|Eikenveien 286|4596 Eiken|4740186500|telhaugen@gmail.com
Theodorsen, Jim Tomas|Einevegen 45|9102 Kvaløysletta|+4777650549 - +4777685237 - +4793406460|jim@dgruppen.no
Thorstensen, Thom|Straumsvegen 275|9109 Kvaløya|+4777659795 - +4797551189|Thom.thorstensen@gmail.com
Thowsen, Per-Jørgen|Olavs Gate 4|3612 Kongsberg|4792429472|per.jorgen.thowsen@kongsberg.com
Tollefsen, Thomas|Brushaugvegen 6|3022 Gjerdrum|4790828202|thomas@fasadespes.no
Torkildsen, Knut|Sirdalsgaten 5|4400 Flekkefjord|+4738322891 - +4790546031|torkildsenror@outlook.com
Trefjord, Andreas|Heireveien 13|8904 Brønnøysund|4793203910|andreas.trefjord@bronnoy.kommune.no
Tufte, Per|Svaleveien 7B|3142 Vestskogen|33388717 - 90551778|per.tufte@online.no
Tunby, Jan R.|Sigbjørn Obstfeldersvei 19|0782 Oslo|+4722494094 - +4791536262|jantunby@gmail.com
Tyvold, Rune|Ranheimsmoen 31D|7054 Ranheim|4741647417|ruty@bama.no
Ulvin, Jan Ståle|Radioveien 27|0884 Oslo|+4722233274 - +4790761117|jan@ulvin.no
Utne, Øystein|Kattanesvegen 84|5690 Lundegrend|4793255129|oystein@utne.nu
Veseth, Elin Dugstad|Kytesvegen 128|5706 Voss|4748232134|elin.du.ve@gmail.com
Veseth, Robert|Kytesvegen 128|5706 Voss|4740484660|robertve@online.no
Walby, Fredrik Andreas|Velliveien 19 A|1358 Jar|4791345195|fredrik.walby@medisin.uio.no
Wang, Pål Anders|Orionvegen 6B|7037 Trondheim|4741584907|palanderswang@gmail.com
Watle, Bjørn|Oscar Borgs Vei 24|1410 Kolbotn|4791627120|bjorn.watle@gmail.com
Watle, Per Arne|Børjerlia 26|1350 Lommedalen|+4767561909 - +4794815629|perarnewatle@gmail.com
Westrum, Tor|Hesttrøa 14|7224 Melhus|+4772873000 - +4790834584|tor.westrum@outlook.com
Weum, Leiv-Jonny|Sjøvegen 7|6450 Hjelset|4741533365|leiv.jonny.weum@gmail.com
Wik, Gunnar|Langeneskilen 20|4640 Søgne|4790070462|gunnarwik72@gmail.com
Willhelmsen, Øyvind|Sandbakkveien 247|9303 Silsand|4791518886|O-willh@online.no
Wilmann, Sture|Bjørndalslia 59|8029 Bodø|+4775584881 - +4799583582|sture.wilmann@iris-salten.no
Wohlen, Olav|Sørberget 9|7657 Verdal|4793867198|olavwohlen@gmail.com
Øie, Ola|Træthaugveien 710|7391 Rennebu|+4772433114 - +4792610098|ola@haugtun.com
Ørjebu, Alfred|Nordvarangervegen 1865|9801 Vadsø|4741566237|alfred.orjebu@gmail.com
Østby, Ole Anders|Engervegen 106|2030 Nannestad|4795110901|oaoest@online.no
Østensen, Daniel Eggesvik|Andreas Markussons Vei 59|8019 Bodø|4795028528|danieloestensen@gmail.com
Øygard, Tom Erik|Evje Gaard|1661 Rolvsøy|95804580|tomoygard@gmail.com
Øygarden, Hans Andreas|Sigyns Veg 6|7602 Levanger||handreas86@gmail.com
Aakervik, Marius|Tømmervegen 4|7804 Namsos|4799260121|marius.aakervik@ntebb.no
Aakervik, Mona Himo|Tømmervegen 4|7804 Namsos|4799038416|monahimoaakervik@gmail.com
Aaknes, Kim Husås|Stordalsveien 1086|7530 Meråker|4745665044|kimaaknes@hotmail.com
Årstad, Egil Oliver|Gamleveien 42|4370 Egersund|4790830025|egil.aarstad@gmail.com
Aasberg, Paal|Haralds vei 10|0576 Oslo|4747967089|paalaasberg@icloud.com
Åselid, Jørn|Mærthas gt 3|8004 Bodø|4795191585|jaaselid@online.no
Åsli, Egil|Veungsdalsvn 28|3615 Kongsberg|4793443712|egil.asli51@gmail.com`;

// Parse og sett inn
const lines = rawData.split('\n');
let inserted = 0;
let skipped = 0;

// Tøm tabellen først
db.exec('DELETE FROM fkf_godkjente_dommere');
console.log('Tømt eksisterende dommere');

const insertStmt = db.prepare(`
    INSERT INTO fkf_godkjente_dommere
    (etternavn, fornavn, adresse, postnummer, sted, telefon1, telefon2, epost)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);

for (const line of lines) {
    const parts = line.split('|');
    if (parts.length < 4) {
        skipped++;
        continue;
    }

    // Parse navn (Etternavn, Fornavn)
    const navnParts = parts[0].split(',').map(p => p.trim());
    const etternavn = navnParts[0] || '';
    const fornavn = navnParts[1] || '';

    // Parse adresse
    const adresse = parts[1] || '';

    // Parse postnummer og sted
    const stedParts = (parts[2] || '').trim().split(' ');
    const postnummer = stedParts[0] || '';
    const sted = stedParts.slice(1).join(' ') || '';

    // Parse telefon (normalisert)
    const telefon1 = normalizePhone(parts[3]);

    // E-post
    const epost = (parts[4] || '').trim();

    if (!etternavn && !fornavn) {
        skipped++;
        continue;
    }

    try {
        insertStmt.run(etternavn, fornavn, adresse, postnummer, sted, telefon1, null, epost);
        inserted++;
    } catch (err) {
        console.error(`Feil ved innsetting av ${fornavn} ${etternavn}:`, err.message);
        skipped++;
    }
}

console.log(`\nImport fullført!`);
console.log(`Satt inn: ${inserted} dommere`);
console.log(`Hoppet over: ${skipped}`);

// Vis de første 5 for verifisering
const verify = db.prepare('SELECT * FROM fkf_godkjente_dommere LIMIT 5').all();
console.log('\nDe første 5 dommerne:');
verify.forEach(d => {
    console.log(`  - ${d.fornavn} ${d.etternavn}, tlf: ${d.telefon1}, e-post: ${d.epost}`);
});

db.close();
