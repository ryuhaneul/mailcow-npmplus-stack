export const WM_THEMES = {
  ink: {
    name: '먹과 여백', src: 'E', desc: '먹색 흑백, 색은 라벨에만. 넓은 여백과 글자 위계',
    layout: { pane: 'none', density: 'normal', compose: 'drawer' },
    shape: {
      '--font': '"Pretendard","Apple SD Gothic Neo","Noto Sans KR","Malgun Gothic",sans-serif',
      '--font-brand': 'var(--font)', '--brand-ls': '-.02em',
      '--fs-body': '14px', '--fs-row': '14px', '--fs-read': '15.5px', '--fs-h1': '22px', '--fw-h1': '700', '--fw-strong': '600',
      '--icon-sw': '1.6',
      '--r-main': '14px', '--r-side': '0px', '--r-ctl': '8px', '--r-btn': '8px', '--r-nav': '8px', '--r-chip': '6px', '--r-pop': '12px', '--r-search': '10px', '--r-card': '12px', '--r-cbtn': '10px',
      '--app-pad': '8px 8px 8px 0', '--app-gap': '0px', '--side-pad': '14px 10px 12px 14px', '--side-border': '0', '--main-border': '0',
      '--row-h': '46px', '--row-h-compact': '36px', '--cbtn-h': '38px', '--btn-h': '32px', '--top-h': '58px',
      '--nav-cur-bar': 'transparent', '--unread-bar': 'transparent',
      '--kicker-tt': 'none', '--kicker-ls': '.02em', '--kicker-font': 'var(--font)',
      '--cbtn-style': 'primary'
    },
    light: {
      '--canvas': '#F5F5F3', '--surface': '#FFFFFF', '--sunken': '#F4F4F2', '--hover': '#F6F6F4', '--sel-n': '#EEEEEB', '--line': '#E8E8E4', '--line-2': '#D8D8D3',
      '--ink': '#141416', '--ink-2': '#47474D', '--ink-3': '#66666D', '--side-bg': 'transparent',
      '--warn': '#B54708', '--warn-bg': '#FEF6EE', '--danger': '#B42318', '--on-danger': '#FFFFFF', '--danger-bg': '#FEF3F2', '--ok': '#1E7A45',
      '--mark': '#FFEDAD', '--mark-ink': '#141416', '--star': '#B7791F', '--unread': '#141416', '--scrim': 'rgba(18,18,20,.36)',
      '--sheet': '0 1px 2px rgba(20,20,22,.04),0 0 0 1px rgba(20,20,22,.05)',
      '--float': '0 1px 2px rgba(20,20,22,.06),0 12px 40px -8px rgba(20,20,22,.22),0 0 0 1px rgba(20,20,22,.06)',
      '--code-tag': '#1F4CA8', '--code-attr': '#7A4B00', '--code-str': '#1B6B3A',
      '--nav-cur-bg': 'var(--surface)', '--nav-cur-shadow': 'var(--sheet)', '--sel-mode': 'neutral'
    },
    dark: {
      '--canvas': '#0B0B0D', '--surface': '#141417', '--sunken': '#1A1A1E', '--hover': '#1B1B1F', '--sel-n': '#232328', '--line': '#25252B', '--line-2': '#34343B',
      '--ink': '#EDEDF0', '--ink-2': '#ABABB4', '--ink-3': '#90909A', '--side-bg': 'transparent',
      '--warn': '#F5A524', '--warn-bg': '#2A1E0C', '--danger': '#F97066', '--on-danger': '#1A0705', '--danger-bg': '#2A1412', '--ok': '#5BD08A',
      '--mark': '#4D3D0A', '--mark-ink': '#FFF4CF', '--star': '#E0A33A', '--unread': '#EDEDF0', '--scrim': 'rgba(0,0,0,.6)',
      '--sheet': '0 0 0 1px rgba(255,255,255,.04)',
      '--float': '0 0 0 1px rgba(255,255,255,.07),0 18px 48px -8px rgba(0,0,0,.7)',
      '--code-tag': '#A3BFF5', '--code-attr': '#F0C677', '--code-str': '#8FD8A8',
      '--nav-cur-bg': 'var(--surface)', '--nav-cur-shadow': 'var(--sheet)', '--sel-mode': 'neutral'
    },
    labels: {
      light: [['#EEEEEB','#3B3B40','#8A8A91'],['#E5F3EA','#17643A','#2F9E5B'],['#E7EEFC','#1F4CA8','#3B6FE0'],['#FBF0DC','#774800','#D08A12'],['#F1EAFB','#5B2E9E','#8B5CD6'],['#ECEEF1','#3E4652','#7D8794'],['#FBE9ED','#98203F','#D9466D'],['#E0F3F1','#0F5F5A','#1F9690']],
      dark:  [['#26262B','#C9C9D0','#8E8E97'],['#15291D','#8FD8A8','#46B874'],['#17213A','#A9C3F7','#6690EC'],['#33260F','#F0C677','#E0A33A'],['#261C38','#CDB6F3','#A585E6'],['#23262B','#BEC5CE','#8D97A3'],['#36161F','#F3AFC0','#E5728F'],['#112B2A','#89D6D0','#3BB5AD']]
    },
    swatches: [
      ['먹', '#141416', '#EDEDF0'], ['쪽빛', '#1F4CA8', '#A9C3F7'], ['솔잎', '#17643A', '#8FD8A8'], ['자주', '#98203F', '#F3AFC0'],
      ['황토', '#774800', '#F0C677'], ['보라', '#5B2E9E', '#CDB6F3'], ['청록', '#0F5F5A', '#89D6D0']
    ]
  },

  seland: {
    name: 'seland', src: 'S', desc: '청록 강조, 고정폭 머리말. 다크에서는 별이 흐르는 배경',
    layout: { pane: 'none', density: 'normal', compose: 'full' },
    shape: {
      '--font': '"Pretendard","Apple SD Gothic Neo","Noto Sans KR","Malgun Gothic",sans-serif',
      '--font-brand': '"JetBrains Mono","Pretendard","Noto Sans KR",ui-monospace,monospace', '--brand-ls': '-.02em',
      '--fs-body': '15px', '--fs-row': '14.5px', '--fs-read': '16px', '--fs-h1': '20px', '--fw-h1': '700', '--fw-strong': '700',
      '--icon-sw': '1.8',
      '--r-main': '12px', '--r-side': '12px', '--r-ctl': '8px', '--r-btn': '8px', '--r-nav': '7px', '--r-chip': '999px', '--r-pop': '10px', '--r-search': '8px', '--r-card': '9px', '--r-cbtn': '8px',
      '--app-pad': '14px 16px 16px', '--app-gap': '14px', '--side-pad': '12px 10px 10px', '--side-border': '1px solid var(--line)', '--main-border': '1px solid var(--line)',
      '--row-h': '48px', '--row-h-compact': '38px', '--cbtn-h': '44px', '--btn-h': '36px', '--top-h': '62px',
      '--nav-cur-bar': 'var(--accent-ui)', '--unread-bar': 'var(--accent-ui)',
      '--kicker-tt': 'uppercase', '--kicker-ls': '.1em', '--kicker-font': '"JetBrains Mono","Pretendard","Noto Sans KR",ui-monospace,monospace',
      '--cbtn-style': 'primary'
    },
    light: {
      '--canvas': '#F4F4F2', '--surface': '#FFFFFF', '--sunken': '#F4F4F2', '--hover': '#EDEDE9', '--sel-n': '#EDEDE9', '--line': '#DEDEDA', '--line-2': '#C9C9C4',
      '--ink': '#1A1A1A', '--ink-2': '#4E5357', '--ink-3': '#5A5F63', '--side-bg': 'var(--surface)',
      '--warn': '#8A5A0B', '--warn-bg': '#FBF1DF', '--danger': '#A3312A', '--on-danger': '#FFFFFF', '--danger-bg': '#FBEBEA', '--ok': '#196B4D',
      '--mark': '#FBF1DF', '--mark-ink': '#1A1A1A', '--star': '#8A5A0B', '--unread': '#0B5F58', '--scrim': 'rgba(0,0,0,.42)',
      '--sheet': 'none', '--float': '0 10px 28px rgba(0,0,0,.16),0 0 0 1px var(--line)',
      '--code-tag': '#0B5F58', '--code-attr': '#8A5A0B', '--code-str': '#2B5C9E',
      '--nav-cur-bg': 'var(--hover)', '--nav-cur-shadow': 'none', '--sel-mode': 'accent'
    },
    dark: {
      '--canvas': '#101214', '--surface': '#171A1D', '--sunken': '#13161A', '--hover': '#1B1F23', '--sel-n': '#1B1F23', '--line': '#24282C', '--line-2': '#343A40',
      '--ink': '#D6D8DA', '--ink-2': '#A9AFB4', '--ink-3': '#979EA3', '--side-bg': 'var(--surface)',
      '--warn': '#E0B36A', '--warn-bg': '#261F12', '--danger': '#F09189', '--on-danger': '#1A0705', '--danger-bg': '#2A1A19', '--ok': '#7FCFA6',
      '--mark': '#3A3015', '--mark-ink': '#F3E3C0', '--star': '#E0B36A', '--unread': '#5EBFB4', '--scrim': 'rgba(0,0,0,.55)',
      '--sheet': 'none', '--float': '0 10px 28px rgba(0,0,0,.5),0 0 0 1px var(--line)',
      '--code-tag': '#5EBFB4', '--code-attr': '#E0B36A', '--code-str': '#7FA8E0',
      '--nav-cur-bg': 'var(--hover)', '--nav-cur-shadow': 'none', '--sel-mode': 'accent'
    },
    labels: {
      light: [['#EEEEEA','#4E5357','#5A6470'],['#E3F0EE','#0B5F58','#0B5F58'],['#E6EDF7','#2B5C9E','#2B5C9E'],['#F6EEDF','#7A4F08','#8A5A0B'],['#F5E6EE','#8C3460','#9C3D6B'],['#ECEFF1','#4D5761','#5A6470'],['#EDF1E4','#44601A','#4F6B1F'],['#F1EDE6','#5E4F3B','#6B5B45']],
      dark:  [['#1F2327','#A3A9AE','#8A9095'],['#14282A','#5EBFB4','#5EBFB4'],['#18233A','#7FA8E0','#7FA8E0'],['#2A2416','#E0B36A','#E0B36A'],['#2D1A25','#E08AB4','#E08AB4'],['#1F2428','#9AA4AE','#9AA4AE'],['#1F2716','#A8C76A','#A8C76A'],['#28231B','#C2AE8E','#C2AE8E']]
    },
    swatches: [
      ['청록', '#0B5F58', '#5EBFB4'], ['바다', '#1E5A8C', '#7FB4E0'], ['숲', '#2E6B2E', '#8FCB8F'], ['황토', '#8A5A0B', '#E0B36A'],
      ['자주', '#8C2F5E', '#E08AB4'], ['쪽', '#3B3F9E', '#A3A8F0'], ['먹', '#2A2F33', '#C9CED2']
    ]
  },

  terra: {
    name: '종이·테라코타', src: 'A', desc: '따뜻한 종이색 바탕, 둥근 단추, 테라코타 강조',
    layout: { pane: 'none', density: 'normal', compose: 'float' },
    shape: {
      '--font': '"Pretendard","Apple SD Gothic Neo","Noto Sans KR","Malgun Gothic",sans-serif',
      '--font-brand': 'var(--font)', '--brand-ls': '-.02em',
      '--fs-body': '14px', '--fs-row': '14px', '--fs-read': '16px', '--fs-h1': '21px', '--fw-h1': '700', '--fw-strong': '700',
      '--icon-sw': '1.8',
      '--r-main': '16px', '--r-side': '0px', '--r-ctl': '10px', '--r-btn': '18px', '--r-nav': '0 17px 17px 0', '--r-chip': '5px', '--r-pop': '10px', '--r-search': '24px', '--r-card': '12px', '--r-cbtn': '16px',
      '--app-pad': '0 16px 0 0', '--app-gap': '0px', '--side-pad': '12px 12px 12px 0', '--side-border': '0', '--main-border': '0',
      '--row-h': '44px', '--row-h-compact': '34px', '--cbtn-h': '52px', '--btn-h': '36px', '--top-h': '62px',
      '--nav-cur-bar': 'transparent', '--unread-bar': 'transparent',
      '--kicker-tt': 'none', '--kicker-ls': '0', '--kicker-font': 'var(--font)',
      '--cbtn-style': 'soft'
    },
    light: {
      '--canvas': '#F6F4EF', '--surface': '#FFFFFF', '--sunken': '#EFECE5', '--hover': '#F4F1EB', '--sel-n': '#FBEDE7', '--line': '#E2DED5', '--line-2': '#CFCAC0',
      '--ink': '#1E1C19', '--ink-2': '#5B574F', '--ink-3': '#6A655B', '--side-bg': 'transparent',
      '--warn': '#B45309', '--warn-bg': '#FDF6EE', '--danger': '#B42318', '--on-danger': '#FFFFFF', '--danger-bg': '#FCEDEA', '--ok': '#2F7A4A',
      '--mark': '#FBEBC8', '--mark-ink': '#1E1C19', '--star': '#B7791F', '--unread': '#1E1C19', '--scrim': 'rgba(30,28,25,.4)',
      '--sheet': 'none', '--float': '0 1px 2px rgba(30,28,25,.08),0 8px 28px rgba(30,28,25,.14),0 0 0 1px var(--line)',
      '--code-tag': '#A8381B', '--code-attr': '#6B4500', '--code-str': '#0B5345',
      '--nav-cur-bg': 'var(--accent-soft)', '--nav-cur-shadow': 'none', '--sel-mode': 'accent'
    },
    dark: {
      '--canvas': '#151412', '--surface': '#1D1C19', '--sunken': '#2A2824', '--hover': '#24221F', '--sel-n': '#2E211B', '--line': '#34312B', '--line-2': '#46423A',
      '--ink': '#EEEAE2', '--ink-2': '#B3ADA2', '--ink-3': '#A39D92', '--side-bg': 'transparent',
      '--warn': '#F59E0B', '--warn-bg': '#2C210E', '--danger': '#F87171', '--on-danger': '#2A0707', '--danger-bg': '#2E1716', '--ok': '#6FCF97',
      '--mark': '#3D2E0E', '--mark-ink': '#F4CF7B', '--star': '#E9B949', '--unread': '#EEEAE2', '--scrim': 'rgba(0,0,0,.6)',
      '--sheet': 'none', '--float': '0 1px 2px rgba(0,0,0,.4),0 12px 32px rgba(0,0,0,.55),0 0 0 1px var(--line)',
      '--code-tag': '#F2A58E', '--code-attr': '#F1D08A', '--code-str': '#9FD3C1',
      '--nav-cur-bg': 'var(--accent-soft)', '--nav-cur-shadow': 'none', '--sel-mode': 'accent'
    },
    labels: {
      light: [['#ECE9E2','#4F4A42','#9C958A'],['#D7EEE8','#0B5345','#138A72'],['#DCE7FA','#1B3F8A','#3466D6'],['#FBEBC8','#6B4500','#C98A0B'],['#EBE1F7','#55248F','#8A55C9'],['#E3E6EA','#37414D','#74808E'],['#F7E1DA','#7A2610','#C4573A'],['#ECE6DA','#4F4535','#9C8B6E']],
      dark:  [['#2B2925','#CFC9BE','#9C958A'],['#143A33','#8EE0CB','#3CC3A3'],['#1B2B4D','#A9C3F7','#6E95EE'],['#3D2E0E','#F4CF7B','#E3A72F'],['#33244A','#D2B9F2','#B08AE3'],['#2B3036','#C3CBD4','#8C98A6'],['#3A2119','#F7B7A3','#E57F62'],['#36312A','#D8CDB9','#B3A386']]
    },
    swatches: [
      ['테라코타', '#A8381B', '#F2896B'], ['벽돌', '#8E2F23', '#EE9A8A'], ['겨자', '#8A5A00', '#E9B949'], ['이끼', '#3E6B3A', '#9CCB8F'],
      ['남색', '#2B4C8C', '#9DB8F0'], ['자두', '#7B2E5E', '#E7A1CB'], ['고동', '#5B4636', '#D3BBA5']
    ]
  },

  amber: {
    name: '촘촘한 회색·호박색', src: 'B', desc: '회색 작업대, 각진 모서리, 호박색 강조. 한 화면에 많이',
    layout: { pane: 'right', density: 'compact', compose: 'float' },
    shape: {
      '--font': '"Pretendard","Apple SD Gothic Neo","Noto Sans KR","Malgun Gothic",sans-serif',
      '--font-brand': 'var(--font)', '--brand-ls': '-.02em',
      '--fs-body': '13.5px', '--fs-row': '13.5px', '--fs-read': '15px', '--fs-h1': '17px', '--fw-h1': '800', '--fw-strong': '700',
      '--icon-sw': '1.8',
      '--r-main': '0px', '--r-side': '0px', '--r-ctl': '4px', '--r-btn': '4px', '--r-nav': '0px', '--r-chip': '3px', '--r-pop': '6px', '--r-search': '4px', '--r-card': '6px', '--r-cbtn': '4px',
      '--app-pad': '0', '--app-gap': '1px', '--side-pad': '10px 0 10px 0', '--side-border': '0', '--main-border': '0',
      '--row-h': '42px', '--row-h-compact': '32px', '--cbtn-h': '34px', '--btn-h': '30px', '--top-h': '48px',
      '--nav-cur-bar': 'var(--accent-ui)', '--unread-bar': 'transparent',
      '--kicker-tt': 'uppercase', '--kicker-ls': '.04em', '--kicker-font': 'var(--font)',
      '--cbtn-style': 'primary'
    },
    light: {
      '--canvas': '#D3D8DE', '--surface': '#FFFFFF', '--sunken': '#F4F5F7', '--hover': '#F0F2F5', '--sel-n': '#FFF6DE', '--line': '#D3D8DE', '--line-2': '#BCC3CB',
      '--ink': '#14171B', '--ink-2': '#4D5560', '--ink-3': '#5E6670', '--side-bg': '#F4F5F7',
      '--warn': '#A34A06', '--warn-bg': '#FFF3D1', '--danger': '#B42318', '--on-danger': '#FFFFFF', '--danger-bg': '#FDECEA', '--ok': '#1A6B3C',
      '--mark': '#FFF3D1', '--mark-ink': '#14171B', '--star': '#B7791F', '--unread': '#1D5FD1', '--scrim': 'rgba(20,23,27,.42)',
      '--sheet': 'none', '--float': '0 2px 4px rgba(20,23,27,.08),0 12px 32px rgba(20,23,27,.16),0 0 0 1px var(--line)',
      '--code-tag': '#8A4B00', '--code-attr': '#1B5DA8', '--code-str': '#1A6B3C',
      '--nav-cur-bg': 'var(--surface)', '--nav-cur-shadow': 'none', '--sel-mode': 'accent'
    },
    dark: {
      '--canvas': '#2A3038', '--surface': '#15181C', '--sunken': '#1B1F24', '--hover': '#1E2328', '--sel-n': '#262012', '--line': '#2A3038', '--line-2': '#3A424C',
      '--ink': '#E7EAEE', '--ink-2': '#A6AEB8', '--ink-3': '#98A1AC', '--side-bg': '#1B1F24',
      '--warn': '#F59E0B', '--warn-bg': '#2E2610', '--danger': '#F87171', '--on-danger': '#2A0707', '--danger-bg': '#2E1616', '--ok': '#5FD08F',
      '--mark': '#2E2610', '--mark-ink': '#F5BC3C', '--star': '#E9B949', '--unread': '#7FB0FF', '--scrim': 'rgba(0,0,0,.6)',
      '--sheet': 'none', '--float': '0 2px 4px rgba(0,0,0,.4),0 14px 36px rgba(0,0,0,.6),0 0 0 1px var(--line)',
      '--code-tag': '#F5C04A', '--code-attr': '#8CC8FF', '--code-str': '#A8E6B4',
      '--nav-cur-bg': 'var(--surface)', '--nav-cur-shadow': 'none', '--sel-mode': 'accent'
    },
    labels: {
      light: [['#E9ECEF','#3F4650','#8A939E'],['#D7EEE8','#0B5345','#138A72'],['#DCE7FA','#1B3F8A','#3466D6'],['#FBEBC8','#6B4500','#C98A0B'],['#EBE1F7','#55248F','#8A55C9'],['#E3E6EA','#37414D','#74808E'],['#FBE3E6','#8A1F35','#D24A63'],['#ECE6DA','#4F4535','#9C8B6E']],
      dark:  [['#22272D','#C3CBD4','#8C98A6'],['#143A33','#8EE0CB','#3CC3A3'],['#1B2B4D','#A9C3F7','#6E95EE'],['#3D2E0E','#F4CF7B','#E3A72F'],['#33244A','#D2B9F2','#B08AE3'],['#2B3036','#C3CBD4','#8C98A6'],['#3A1A22','#F5AFC0','#E5728F'],['#36312A','#D8CDB9','#B3A386']]
    },
    swatches: [
      ['호박', '#F2A900', '#F2A900'], ['파랑', '#1D5FD1', '#7FB0FF'], ['초록', '#1A8F4A', '#5FD08F'], ['주황', '#E5590F', '#FF9A5C'],
      ['청록', '#00A3A3', '#4FD6D6'], ['보라', '#7048E8', '#B197FC'], ['쥐색', '#4D5560', '#A6AEB8']
    ]
  },

  olive: {
    name: '종이·올리브', src: 'K', desc: '종이 질감 바탕, 큰 제목과 넉넉한 글자, 올리브 강조',
    layout: { pane: 'none', density: 'normal', compose: 'full' },
    shape: {
      '--font': '"Pretendard","Noto Sans KR","Apple SD Gothic Neo","Malgun Gothic",sans-serif',
      '--font-brand': 'var(--font)', '--brand-ls': '2px',
      '--fs-body': '15px', '--fs-row': '15px', '--fs-read': '16px', '--fs-h1': '28px', '--fw-h1': '650', '--fw-strong': '650',
      '--icon-sw': '1.6',
      '--r-main': '0px', '--r-side': '0px', '--r-ctl': '5px', '--r-btn': '6px', '--r-nav': '6px', '--r-chip': '4px', '--r-pop': '8px', '--r-search': '6px', '--r-card': '6px', '--r-cbtn': '6px',
      '--app-pad': '0', '--app-gap': '0px', '--side-pad': '20px 16px 14px', '--side-border': '0', '--main-border': '0',
      '--row-h': '60px', '--row-h-compact': '42px', '--cbtn-h': '46px', '--btn-h': '36px', '--top-h': '68px',
      '--nav-cur-bar': 'transparent', '--unread-bar': 'transparent',
      '--kicker-tt': 'none', '--kicker-ls': '.02em', '--kicker-font': 'var(--font)',
      '--cbtn-style': 'primary'
    },
    light: {
      '--canvas': '#EDEEE6', '--surface': '#FFFEFA', '--sunken': '#F5F4EF', '--hover': '#F1F2EA', '--sel-n': '#E8EDDE', '--line': '#DCDED3', '--line-2': '#C6C9BC',
      '--ink': '#252A23', '--ink-2': '#4E5449', '--ink-3': '#62675E', '--side-bg': '#EDEEE6',
      '--warn': '#8B421E', '--warn-bg': '#FFF0DF', '--danger': '#A03430', '--on-danger': '#FFFFFF', '--danger-bg': '#F9E9E5', '--ok': '#3F6A2C',
      '--mark': '#F2E6B8', '--mark-ink': '#252A23', '--star': '#8B6A12', '--unread': '#415336', '--scrim': 'rgba(37,42,35,.42)',
      '--sheet': 'none', '--float': '0 5px 20px rgba(0,0,0,.13),0 0 0 1px var(--line)',
      '--code-tag': '#285D76', '--code-attr': '#8B421E', '--code-str': '#415336',
      '--nav-cur-bg': 'var(--accent-soft)', '--nav-cur-shadow': 'none', '--sel-mode': 'accent'
    },
    dark: {
      '--canvas': '#1D221C', '--surface': '#212620', '--sunken': '#191D19', '--hover': '#283027', '--sel-n': '#34412C', '--line': '#41493D', '--line-2': '#566051',
      '--ink': '#EEF0E7', '--ink-2': '#C3CBBC', '--ink-3': '#AFB8A8', '--side-bg': '#1D221C',
      '--warn': '#F6BD8D', '--warn-bg': '#443221', '--danger': '#F6ABA1', '--on-danger': '#2A0E0C', '--danger-bg': '#492D2B', '--ok': '#B5D99A',
      '--mark': '#4A4220', '--mark-ink': '#F5ECC4', '--star': '#E3C46B', '--unread': '#C0D6A7', '--scrim': 'rgba(0,0,0,.6)',
      '--sheet': 'none', '--float': '0 8px 28px rgba(0,0,0,.5),0 0 0 1px var(--line)',
      '--code-tag': '#A7D2E5', '--code-attr': '#F6BD8D', '--code-str': '#C0D6A7',
      '--nav-cur-bg': 'var(--accent-soft)', '--nav-cur-shadow': 'none', '--sel-mode': 'accent'
    },
    labels: {
      light: [['#ECEDE5','#4E5449','#8A8F82'],['#E8EDDE','#415336','#6B8456'],['#E6F0F3','#285D76','#3F7F9C'],['#FFF0DF','#8B421E','#C46A36'],['#EEE7F0','#5C3F6B','#8C6A9E'],['#EAEBE6','#474C44','#7C8276'],['#F7E6E2','#8E2F2B','#C25A50'],['#ECEBDD','#5A5527','#9A9150']],
      dark:  [['#2A3029','#C3CBBC','#8E978A'],['#34412C','#C0D6A7','#90AE72'],['#293E47','#A7D2E5','#6FAAC4'],['#443221','#F6BD8D','#D98F57'],['#3A2F40','#DCC4E8','#B08EC2'],['#2C312B','#C9CFC2','#98A091'],['#492D2B','#F6ABA1','#DB7D72'],['#3B3A26','#E3DCA6','#BEB46E']]
    },
    swatches: [
      ['올리브', '#415336', '#C0D6A7'], ['이끼', '#55652A', '#CFDB9A'], ['물빛', '#285D76', '#A7D2E5'], ['흙', '#8B421E', '#F6BD8D'],
      ['솔', '#2F5D4A', '#9FD1BC'], ['포도', '#5C3F6B', '#D3B8E3'], ['먹', '#33372F', '#D7DBD0']
    ]
  }
};
export const WM_THEME_ORDER = ['ink', 'seland', 'terra', 'amber', 'olive'];

