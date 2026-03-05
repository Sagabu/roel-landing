// =====================================================
// VINTERPRØVEN 2026 - TESTDATA INITIALISERING
// =====================================================
// Kjør initTestData() i konsollen for å nullstille og laste inn testdata

function initTestData() {
    // Slett all eksisterende data
    const keysToRemove = [];
    for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && (
            key.startsWith('judgeData_') ||
            key.startsWith('userDogs') ||
            key.startsWith('userProfile') ||
            key.startsWith('userTrials') ||
            key === 'clubAdmins' ||
            key === 'registeredClubs' ||
            key === 'clubTrials' ||
            key === 'currentTrialId' ||
            key === 'judgeSession' ||
            key === 'vinterproven_participants'
        )) {
            keysToRemove.push(key);
        }
    }
    keysToRemove.forEach(key => localStorage.removeItem(key));

    // =====================================================
    // KLUBBER
    // =====================================================
    const clubs = [
        { id: 'namdal', orgNumber: '987654321', name: 'Namdal Fuglehundklubb', region: 'Trøndelag' },
        { id: 'malvik', orgNumber: '987654322', name: 'Malvik Fuglehundklubb', region: 'Trøndelag' },
        { id: 'selbu', orgNumber: '987654323', name: 'Selbu Fuglehundklubb', region: 'Trøndelag' },
        { id: 'sorfjeldske', orgNumber: '987654324', name: 'Sørfjeldske Fuglehundklubb', region: 'Trøndelag' },
        { id: 'stjordal', orgNumber: '987654325', name: 'Stjørdal Fuglehundklubb', region: 'Trøndelag' }
    ];
    localStorage.setItem('registeredClubs', JSON.stringify(clubs));

    // =====================================================
    // KLUBB ADMINISTRATORER
    // =====================================================
    const clubAdmins = {
        '99999997': {
            clubId: 'namdal',
            clubName: 'Namdal Fuglehundklubb',
            name: 'Monja Aakert',
            role: 'Klubbleder'
        }
    };
    localStorage.setItem('clubAdmins', JSON.stringify(clubAdmins));

    // =====================================================
    // BRUKERE MED HUNDER
    // =====================================================
    const userDogs = {
        '99999999': [ // Chris Niebel
            {
                id: '1',
                name: 'Breton XXL',
                regNumber: 'NO45678/22',
                breed: 'Breton',
                gender: 'male',
                birthDate: '2020-05-15',
                owner: 'Chris Niebel',
                club: 'Namdal Fuglehundklubb',
                results: [
                    { date: '2024-09-14', trial: 'Namdalseid Høstprøve', class: 'AK', prize: '2. AK', judge: 'Kari Olsen' },
                    { date: '2024-03-22', trial: 'Vårprøven Steinkjer', class: 'AK', prize: '1. AK', judge: 'Per Hansen' },
                    { date: '2023-09-10', trial: 'Høstprøven Namsos', class: 'UK', prize: '2. UK', judge: 'Monja Aakert' }
                ]
            }
        ],
        '99999998': [ // Gæggen Wågert
            {
                id: '2',
                name: 'Zico',
                regNumber: 'NO34567/21',
                breed: 'Gordon Setter',
                gender: 'male',
                birthDate: '2019-03-20',
                owner: 'Gæggen Wågert',
                club: 'Malvik Fuglehundklubb',
                results: [
                    { date: '2024-10-05', trial: 'Malvik Høstprøve', class: 'VK', prize: '3. VK', judge: 'Arne Fjell' },
                    { date: '2024-04-12', trial: 'Trondheim Vårprøve', class: 'AK', prize: '1. AK', judge: 'Liv Strand' },
                    { date: '2023-09-28', trial: 'NM Fuglehund', class: 'AK', prize: '2. AK', judge: 'Tor Dahl' }
                ]
            },
            {
                id: '3',
                name: 'Mainoo',
                regNumber: 'NO45123/23',
                breed: 'Gordon Setter',
                gender: 'male',
                birthDate: '2021-07-10',
                owner: 'Gæggen Wågert',
                club: 'Malvik Fuglehundklubb',
                results: [
                    { date: '2024-09-20', trial: 'Selbu Prøve', class: 'UK', prize: '1. UK', judge: 'Hans Mo' },
                    { date: '2024-05-18', trial: 'Vårprøven Klæbu', class: 'UK', prize: '2. UK', judge: 'Gerd Vik' }
                ]
            }
        ],
        '99999997': [ // Monja Aakert
            {
                id: '4',
                name: 'Tripp',
                regNumber: 'NO23456/20',
                breed: 'Gordon Setter',
                gender: 'male',
                birthDate: '2018-02-14',
                owner: 'Monja Aakert',
                club: 'Namdal Fuglehundklubb',
                results: [
                    { date: '2024-10-12', trial: 'Namdal Høstprøve', class: 'VK', prize: 'CERT', judge: 'Ole Nordmann' },
                    { date: '2024-06-08', trial: 'Sommerprøven Lierne', class: 'VK', prize: '1. VK', judge: 'Roar Storseth' },
                    { date: '2023-10-21', trial: 'NM Fuglehund', class: 'VK', prize: '2. VK', judge: 'Knut Lie' }
                ]
            },
            {
                id: '5',
                name: 'Trapp',
                regNumber: 'NO23457/20',
                breed: 'Gordon Setter',
                gender: 'male',
                birthDate: '2018-02-14',
                owner: 'Monja Aakert',
                club: 'Namdal Fuglehundklubb',
                results: [
                    { date: '2024-09-30', trial: 'Grong Høstprøve', class: 'AK', prize: '1. AK', judge: 'Stein Berg' },
                    { date: '2024-04-20', trial: 'Vårprøven Namdalen', class: 'AK', prize: '2. AK', judge: 'Liv Mo' }
                ]
            }
        ],
        '99999996': [ // Torstein Møstn
            {
                id: '6',
                name: 'Stora',
                regNumber: 'NO56789/21',
                breed: 'Irsk Setter',
                gender: 'female',
                birthDate: '2019-08-22',
                owner: 'Torstein Møstn',
                club: 'Selbu Fuglehundklubb',
                results: [
                    { date: '2024-09-15', trial: 'Selbu Høstprøve', class: 'AK', prize: '1. AK', judge: 'Eva Dahl' },
                    { date: '2024-05-05', trial: 'Vårprøven Tydal', class: 'AK', prize: '3. AK', judge: 'Odd Lie' },
                    { date: '2023-09-22', trial: 'Røros Prøve', class: 'UK', prize: '1. UK', judge: 'Marit Vik' }
                ]
            },
            {
                id: '7',
                name: 'Petra',
                regNumber: 'NO56790/22',
                breed: 'Irsk Setter',
                gender: 'female',
                birthDate: '2020-04-18',
                owner: 'Torstein Møstn',
                club: 'Selbu Fuglehundklubb',
                results: [
                    { date: '2024-10-01', trial: 'Holtålen Prøve', class: 'UK', prize: '2. UK', judge: 'Jon Berg' },
                    { date: '2024-06-15', trial: 'Sommerprøven Selbu', class: 'UK', prize: '1. UK', judge: 'Anne Mo' }
                ]
            }
        ],
        '99999995': [ // Marstein Manstein
            {
                id: '8',
                name: 'Bleiebøtte',
                regNumber: 'NO67890/23',
                breed: 'Irsk Setter',
                gender: 'female',
                birthDate: '2021-11-30',
                owner: 'Marstein Manstein',
                club: 'Sørfjeldske Fuglehundklubb',
                results: [
                    { date: '2024-09-08', trial: 'Oppdal Høstprøve', class: 'UK', prize: '1. UK', judge: 'Rolf Strand' },
                    { date: '2024-04-28', trial: 'Vårprøven Rennebu', class: 'UK', prize: '3. UK', judge: 'Gro Fjell' }
                ]
            }
        ],
        '99999994': [ // Roar Storseth
            {
                id: '9',
                name: 'Kjemperask',
                regNumber: 'NO78901/22',
                breed: 'Engelsk Setter',
                gender: 'male',
                birthDate: '2020-09-05',
                owner: 'Roar Storseth',
                club: 'Stjørdal Fuglehundklubb',
                results: [
                    { date: '2024-10-08', trial: 'Stjørdal Høstprøve', class: 'VK', prize: '2. VK', judge: 'Tor Hansen' },
                    { date: '2024-05-25', trial: 'Vårprøven Meråker', class: 'AK', prize: '1. AK', judge: 'Liv Olsen' },
                    { date: '2023-10-14', trial: 'Levanger Prøve', class: 'AK', prize: '1. AK', judge: 'Per Mo' }
                ]
            }
        ]
    };
    localStorage.setItem('userDogs', JSON.stringify(userDogs));

    // =====================================================
    // VINTERPRØVEN 2026 - PRØVE
    // =====================================================
    const vinterproven = {
        id: 'vinterproven2026',
        name: 'Vinterprøven 2026',
        location: 'Lierne',
        startDate: '2026-01-17',
        endDate: '2026-01-18',
        club: 'Namdal Fuglehundklubb',
        trialLeader: 'Monja Aakert',
        trialLeaderPhone: '99999997',
        nkkRep: 'Marstein Manstein',
        nkkRepPhone: '99999995',
        status: 'active',
        classes: {
            uk: true,
            ak: true,
            vk: true,
            vkType: '2day' // 2-dagers VK
        },
        parties: {
            day1: {
                ukak: 3, // 3 UK/AK-partier på dag 1
                vkKval: 2 // 2 VK Kval-partier på dag 1
            },
            day2: {
                ukak: 4, // 4 UK/AK-partier på dag 2
                vkFinale: 1 // 1 VK Finale på dag 2
            }
        },
        judges: {
            '99999999': { name: 'Chris Niebel', party: 'ukak1' },
            '99999997': { name: 'Monja Aakert', party: 'vkfinale', role: 1 },
            '99999994': { name: 'Roar Storseth', party: 'ukak2' }
        }
    };

    const clubTrials = [vinterproven];
    localStorage.setItem('clubTrials', JSON.stringify(clubTrials));
    localStorage.setItem('currentTrialId', 'vinterproven2026');

    console.log('✅ Testdata for Vinterprøven 2026 er lastet inn!');
    console.log('');
    console.log('📋 Brukere:');
    console.log('   99999999 - Chris Niebel (deltaker, dommer)');
    console.log('   99999998 - Gæggen Wågert (deltaker)');
    console.log('   99999997 - Monja Aakert (prøveleder, klubbleder, dommer, deltaker)');
    console.log('   99999996 - Torstein Møstn (deltaker)');
    console.log('   99999995 - Marstein Manstein (NKK-rep, deltaker)');
    console.log('   99999994 - Roar Storseth (deltaker, dommer)');
    console.log('');
    console.log('📍 Vinterprøven 2026 - Lierne');
    console.log('   Dag 1: 3 UK/AK-parti, 2 VK Kval');
    console.log('   Dag 2: 4 UK/AK-parti, 1 VK Finale');
    console.log('');
    console.log('🔑 SMS-kode for alle: 1234');

    return true;
}

// Kjør automatisk ved lasting
if (typeof window !== 'undefined') {
    window.initTestData = initTestData;
}
