/* ============================================================
 * 票小帮 · 台账规则引擎（纯函数模块，浏览器 / Node 通用）
 * 功能：发票类型识别、销售方简称、商品摘要、费用分类、
 *       特殊情况提示、重命名文件名、14列样式Excel导出
 * ============================================================ */
(function (global) {
  'use strict';

  /* ---------- 基础工具 ---------- */

  // '2026年08月15日' / '2026-08-15' / '2026/8/5' → '2026-08-15'
  function formatDateDash(date) {
    if (!date) return '';
    const m = String(date).match(/(\d{4})[年\-\/.](\d{1,2})[月\-\/.](\d{1,2})日?/);
    if (m) return m[1] + '-' + m[2].padStart(2, '0') + '-' + m[3].padStart(2, '0');
    return String(date);
  }

  // '2026年08月15日' → '20260815'
  function formatDateCompact(date) {
    return formatDateDash(date).replace(/-/g, '');
  }

  function round2(n) {
    return Math.round((parseFloat(n) || 0) * 100) / 100;
  }

  function totalOf(inv) {
    return round2((parseFloat(inv.amount) || 0) + (parseFloat(inv.tax) || 0));
  }

  /* ---------- 发票类型 ---------- */

  function detectInvoiceType(clean) {
    if (/电子发票[（(]?增值税专用发票|电子专票|电子增值税专用发票|数电票.{0,8}专票/.test(clean)) return '电子专票';
    if (/电子发票[（(]?增值税普通发票|电子普票|电子增值税普通发票|数电票/.test(clean)) return '电子普票';
    if (/增值税专用发票/.test(clean)) return '纸质专票';
    if (/增值税普通发票/.test(clean)) return '纸质普票';
    return '电子普票';
  }

  /* ---------- 商品/项目摘要 ----------
   * 数电票表头格式："项目名称   规格型号   单   位   数   量   单   价   金   额   税率/征收率   税   额"
   * pdf.js 在中文间插了空格，总长度 55-70 字符；老阈值 50 会过滤掉，需要放宽。
   * 商品行常见格式："*交通运输*橡胶路锥   个   30 2.83 85.15   1% 0.85"，摘要只保留
   * `*xxx*yyy` 主体 + 跨行接续的纯中文规格（避免把单位/数量/金额/税率等明细带进摘要）。
   */
  function extractSummary(rawText) {
    if (!rawText) return '';
    const lines = String(rawText).split('\n').map(l => l.trim());
    let start = -1;
    // 表头行宽松匹配：含"项目名称/货物或应税劳务/服务名称/商品名称/劳务名称"任一关键词即视为表头
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (l && /项目名称|货物或应税劳务|服务名称|商品名称|劳务名称/.test(l)) {
        start = i + 1;
        break;
      }
    }
    if (start < 0) return '';
    let end = lines.length;
    for (let i = start; i < lines.length; i++) {
      if (/价税合计|合计金额|合计税额|合\s*计|备注|销售方信息|购买方信息/.test(lines[i])) {
        end = i;
        break;
      }
    }
    // 表头过滤（含列名）
    const headerRe = /^(项目名称|规格型号|单位|数量|单价|金额|税率|税额|价税合计|备注|销售方|购买方|开票人|复核|收款人|发票号码|开票日期|校验码)\s*$/;
    // 明细数字行过滤：被空格打断的纯数字（如"只   5 15.64 78.20   1% 0.78"）
    const isDetailRow = (l) => {
      const textOnly = l.replace(/[\d,.¥￥%\/()（）\s]/g, '');
      return textOnly.length < 2;
    };
    // 跨行接续识别：纯中文/字母/数字/横线（无空格）通常是规格型号描述行
    // 不再自动合并到上一行（合并会污染主行内的数字明细截断），改为独立保留为规格行
    const isContinuation = (l) => l && /^[\u4e00-\u9fa5*A-Za-z·\-（）()0-9]+$/.test(l) && l.length >= 2 && l.length <= 80;

    const rows = [];
    for (let i = start; i < end; i++) {
      const l = lines[i];
      if (!l || l.length < 2) continue;
      if (headerRe.test(l)) continue;
      if (l === '合计' || /^合计\s*[¥￥]?/.test(l)) continue;
      if (isDetailRow(l)) continue;
      rows.push(l);
    }
    if (rows.length === 0) return '';
    // 摘要主体：每行只保留 `*xxx*yyy*zzz` 星链 + 冒号属性（颜色分类:xxx等），
    // 数字明细（单位/数量/单价/金额/税率/税额）一律不入摘要；
    // 无星链的纯规格/描述行（如"框-超薄款30CM-24W白光"）独立保留
    const takeMain = (s) => {
      const star = s.match(/\*[^*\s]+(?:\*[^*\s]+)*/);
      if (star) {
        let main = star[0];
        const rest = s.slice(star.index + star[0].length);
        const attr = rest.match(/^\s*((?:颜色|分类|型号|规格|颜色分类)[：:][^\s]+)/);
        if (attr) main += ' ' + attr[1].trim();
        return main;
      }
      // 纯数字明细行不入摘要
      if (/^[\d\s,.¥￥%\/()（）]+$/.test(s)) return '';
      // 纯文本（接续规格行）保留
      return s;
    };
    const out = rows.map(takeMain).filter(Boolean).join('；');
    if (out.length > 220) return out.slice(0, 220) + '…';
    return out;
  }

  /* ---------- 销售方简称 ---------- */

  const SHORT_SUFFIXES = ['股份有限公司', '有限责任公司', '有限公司', '个体工商户', '经营部', '经销部', '销售中心', '商行', '网店', '加工厂', '制造厂', '工厂', '餐馆', '饭店', '酒店', '服务部', '服务站', '中心', '厂'];
  const SHORT_INDUSTRY = ['电子商务', '清洁用品', '日用百货', '日用品', '办公用品', '文具用品', '五金机电', '电线电缆', '电缆电线', '电气设备', '信息技术', '信息科技', '网络科技', '智能科技', '科技有限公司', '环保科技', '环保节能', '测绘仪器', '仪器仪表', '机械设备', '钢结构', '建筑工程', '交通设施', '安防设备', '消防器材', '劳保用品', '防护用品', '标准件', '钢丝绳', '塑料制品', '橡胶制品', '通信器材', '通讯器材', '家用电器', '办公设备', '打印设备', '纸业', '印刷包装', '食品', '农副产品', '商贸', '贸易', '工贸', '实业发展', '建设工程', '装饰材料', '文化传媒', '广告', '供应链', '能源', '化工', '园林', '物业', '科技', '网络', '数码', '传媒', '物流', '运输', '工程', '建材', '装修', '建筑', '服务', '发展', '实业', '企业', '蚊香', '日化', '文化', '传播', '清洁'];
  // 仅当公司名（Xxx有限公司）时剥离的行业词；个体户/网店等保留（如：克少五金网店 → 克少五金）
  const COMPANY_STRIP = ['五金', '电器', '机电', '塑业'];
  const SHORT_REGIONS = [
    /^[\u4e00-\u9fa5]{2,7}市[\u4e00-\u9fa5]{1,6}区/,
    /^[\u4e00-\u9fa5]{2,7}市[\u4e00-\u9fa5]{1,6}县/,
    /^[\u4e00-\u9fa5]{2,5}县[\u4e00-\u9fa5]{1,6}镇/,
    /^[\u4e00-\u9fa5]{2,6}县/,
    /^[\u4e00-\u9fa5]{2,5}镇/,
    /^[\u4e00-\u9fa5]{2,7}市/,
    /^[\u4e00-\u9fa5]{2,6}区/
  ];

  function extractShortName(full) {
    if (!full) return '';
    let name = String(full).trim();
    const isCompany = /(股份有限公司|有限责任公司|有限公司)$/.test(name);
    name = name.replace(/[（(][^）)]*[）)]/g, '');
    for (const s of SHORT_SUFFIXES) {
      if (name.endsWith(s)) { name = name.slice(0, -s.length); break; }
    }
    let prev = '';
    while (name !== prev) {
      prev = name;
      for (const w of SHORT_INDUSTRY) {
        if (name.length > w.length + 1 && name.endsWith(w)) {
          name = name.slice(0, -w.length);
          break;
        }
      }
    }
    if (isCompany) {
      let prev2 = '';
      while (name !== prev2) {
        prev2 = name;
        for (const w of COMPANY_STRIP) {
          if (name.length > w.length + 1 && name.endsWith(w)) {
            name = name.slice(0, -w.length);
            break;
          }
        }
      }
    }
    prev = '';
    while (name !== prev) {
      prev = name;
      for (const rp of SHORT_REGIONS) {
        const m = name.match(rp);
        if (m && name.length > m[0].length + 1) { name = name.slice(m[0].length); break; }
      }
    }
    if (name.length > 6) name = name.slice(0, 6);
    return name;
  }

  /* ---------- 费用分类 ---------- */

  const CAT_FOOD = ['餐饮', '餐费', '饭店', '餐馆', '宴请', '招待', '食堂', '外卖', '吃饭', '餐厅', '酒楼', '食府'];
  const CAT_AD = ['广告', '宣传', '海报', '横幅', '展架', '喷绘', '推广', '易拉宝', '发光字', '灯箱'];
  const CAT_WELFARE = ['农夫山泉', '矿泉水', '纯净水', '饮料', '水果', '蜜瓜', '西瓜', '苹果', '香蕉', '橙', '零食', '茶叶', '咖啡', '牛奶', '酸奶', '月饼', '粽子', '礼盒', '坚果', '慰问', '福利', '雪糕', '冰激凌', '啤酒', '红酒', '白酒', '茶点'];
  const CAT_BUILD = ['电路连接', '钢管', '铝管', '电缆', '电线', '线缆', '钢丝绳', '钢筋', '钢材', '路锥', '爆闪灯', '穿线器', '端子', '风机', '集装箱', '气囊', '土工布', '盖土网', '反光背心', '喊话器', '试模', '检测', '推水器', '消防', '镀锌', '五金', '施工', '工程', '建材', '管道', '桥架', '线槽', '开关', '插座', '灯具', '照明', '配电', '护栏', '防撞', '警示', '锥形', '水马', '围挡', '脚手架', '安全帽', '焊条', '切割片', '钻头', '油漆', '涂料', '防水', '保温', '螺丝', '螺栓', '轴承', '电机', '水泵', '阀门', '管件', '接头', '塑料', '橡胶', '测量', '仪器', '砂浆', '水泥', '沙子', '砖', '网片', '波纹管', '灭火器', '蔬菜', '防控仪', '旗帜', '绳子', '试件', '试块', '试验', '标准件', '绳网', '木板', '方木', '盖土', '防护', '警戒', '指示', '标识', '标牌', '防尘', '密目网', '安全网', '扣件', '预埋', '铁件', '钢板', '型钢', '角钢', '槽钢', '圆钢', '螺纹钢', '盘螺', '线材', '镀锌管', '无缝管', '螺旋管', '衬塑管', 'PPR', 'PVC', 'PE管', '混凝土', '石灰', '石膏', '腻子', '乳胶漆', '卷材', '无纺布', '土工膜', '格栅', '石笼', '护坡', '挡墙', '围墙', '围栏', '隔音', '减速带', '凸面镜', '广角镜', '防撞桶', '警示柱', '反光柱', '道钉', '轮廓标', '标线', '反光', '指示牌', '指路牌', '限速', '禁令', '警告牌', '施工牌', '公告牌', '彩旗', '刀旗', '锦旗', '地锚', '膨胀', '锚栓', '植筋胶', '结构胶', '玻璃胶', '密封胶', '发泡胶', '堵漏', '雨棚', '雨篷', '阳光房', '采光', '天窗', '气楼', '通风', '排风', '送风', '新风', '除尘', '喷淋', '雾炮', '排水', '给水', '供水', '管网', '法兰', '弯头', '三通', '管卡', '支架', '吊架', '托架', '配管', '接线盒', '底盒', '面板', '空开', '断路器', '漏保', '接触', '继电器', '熔断器', '避雷器', '浪涌', '接地', '等电位', '绝缘', '套管', '黄腊管', '热缩管', '线鼻子', '接线端子', '铜鼻子', '铜管', '铜排', '铝排', '母线', '变压器', '箱变', '配电房', '发电机', '柴油', '应急电源', '稳压', '监控', '道闸', '伸缩门', '电动门', '门禁', '报警', '探测器', '烟感', '温感', '手报', '声光', '对讲', '广播', '喇叭', '功放', '网线', '光纤', '光缆', '双绞线', '跳线', '配线架', '交换机', '路由器', '机柜', '蓄电池', '充电器', '逆变器', '互感器', '电抗器', '电容器', '补偿', '滤波', '电表', '水表', '气表', '流量计', '压力表', '温度计', '变送器', '传感器', '液位', '料位', '仪表', '控制柜', '配电柜', '配电箱', '动力柜', '照明箱', '计量箱', '电表箱', '水表箱', '弱电箱', '信息箱', '综合布线', '安防', '监控杆', '立杆', '横臂', '抱杆', '底座', '预埋件', '接地极', '接地体', '铜包钢', '降阻', '接地模块', '接地线', '均压环', '避雷针', '避雷带', '接闪', '引下线', '断接卡', '绝缘子', '金具', '线夹', '防震锤', '间隔棒', '悬垂', '耐张', '跳线串', '护线条', '预绞丝', '导线', '地线', '铁塔', '角钢塔', '钢管塔', '塔材', '横担', '抱箍', '拉线', '拉棒', '花篮螺栓', '钢绞线', '铝绞线', '钢芯铝绞', '电缆沟', '电缆井', '工井', '排管', '直埋', '穿管', '电缆支架', '桥架支架', '竖井', '夹层', '防火封堵', '防火泥', '阻火包', '防火板', '防火涂料', '防火门', '防火卷帘', '卷帘门', '挡烟垂壁', '防火玻璃', '防爆', '泄爆', '人防', '防护门', '密闭门', '防化', '气密', '水密', '风管', '风道', '风口', '散流器', '百叶', '风阀', '防火阀', '排烟阀', '送风阀', '静压箱', '消声器', '减振', '软接', '沟槽', '卡箍', '抗震支架', '侧向支撑', '纵向支撑', '斜撑', '横撑', '水平支撑', '垂直支撑', '剪刀撑', '抛撑', '连墙件', '拉接', '顶撑', '可调顶托', '可调底座', '垫板', '钢垫板', '木垫板', '脚手管', '直角扣件', '旋转扣件', '对接扣件', '碗扣', '盘扣', '轮扣', '顶托', '底托', 'U托', '钢笆片', '脚手板', '竹笆', '兜网', '踢脚板', '挡脚板', '护身栏', '防护栏', '临边防护', '洞口防护', '楼梯防护', '电梯井防护', '坠落', '安全绳', '自锁器', '速差', '防坠器', '缓冲器', '安全带', '全身式', '半身式', '保险带', '挂钩', '安全钩', '攀登', '爬梯', '垂直爬梯', '斜爬梯', '护笼', '安全护笼', '护圈', '休息平台', '钢爬梯', '踏步', '防滑踏步', '防滑条', '止滑条', '防滑垫', '防滑板', '格栅板', '钢格栅', '踏步板', '平台板', '花纹板', '防滑纹', '金刚砂', '防滑漆', '防滑砂', '耐磨', '环氧', '环氧地坪', '固化剂', '自流平', '水泥自流平', '环氧自流平', '防静电地板', '全钢', '复合', '硫酸钙', '铝合金', '地板支架', '横梁', '导静电', '防静电', '抗静电', '绝缘地板', '绝缘胶垫', '绝缘板', '绝缘毯', '绝缘垫', '绝缘凳', '绝缘梯', '绝缘靴', '绝缘手套', '验电器', '高压验电', '低压验电', '核相器', '相序表', '钳形电流表', '万用表', '兆欧表', '绝缘电阻', '接地电阻', '回路电阻', '接触电阻', '直流电阻', '介损', '耐压', '校验', '检定', '校准', '标准器', '标准表', '示波器', '频谱分析', '网络分析', '矢量网络', '功率计', '频率计', '计数器', '计时器'];
  const CAT_OFFICE = ['票夹', '中性笔', '笔记本', '复印纸', '打印纸', '打印', '票据打', '打印机', '鼠标', '键盘', '标签纸', '快递', '收派', '顺丰', '墨水', '硒鼓', '粉盒', '碳粉', '抽纸', 'A4纸', 'A5纸', '文件', '档案', '文件夹', '订书', '胶带', '笔', '信封', '装订', '文件袋', '资料册', '电池', 'U盘', '计算器', '电话机', '文具', '办公', '会议桌', '办公桌', '文件柜', '档案柜', '墨粉', '色带'];
  const CAT_OFFICE_RE = [/(tn|ce|cf|hp|w)\d{1,4}粉/, /[a-z]{1,6}\d{1,4}粉/]; // 打印机硒鼓/碳粉型号，如 TN223粉
  const CAT_LOWVALUE = ['垃圾篓', '扫把', '簸箕', '蚊香', '洗衣粉', '灭蚊灯', '拖把', '垃圾袋', '清洁', '洗洁', '抹布', '纸篓', '收纳', '水桶', '刷子', '除臭', '空气清新', '洗液', '香皂', '洗手液', '卷纸', '垃圾桶', '洗涤', '清洁剂', '擦手纸', '马桶', '洁厕', '玻璃水', '洗衣液', '柔顺剂', '消毒液', '洗地', '吸尘器', '垃圾桶', '洗洁精', '餐巾纸', '湿巾', '牙签', '一次性', '全效洗'];

  function classifyCategory(inv) {
    // 摘要为空时才参考销售方名称，避免"五金网店"等销售方把分类带偏
    const summary = String(inv.summary || '');
    const seller = String(inv.seller || '');
    const text = (summary ? summary : seller).toLowerCase();
    const has = (arr) => arr.some(k => text.includes(k.toLowerCase()));
    const hasRe = (res) => res.some(re => re.test(text));
    if (has(CAT_FOOD)) return '管理费用-业务招待费';
    if (has(CAT_AD)) return '管理费用-广告宣传费';
    if (has(CAT_WELFARE)) return '管理费用-福利费';
    if (has(CAT_BUILD)) return '建设费用';
    if (has(CAT_OFFICE) || hasRe(CAT_OFFICE_RE)) return '管理费用-办公费';
    if (has(CAT_LOWVALUE)) return '管理费用-低值易耗品';
    return '待确认';
  }

  const CATEGORIES = ['管理费用-办公费', '管理费用-低值易耗品', '管理费用-福利费', '管理费用-业务招待费', '管理费用-广告宣传费', '管理费用-差旅费', '管理费用-通讯费', '管理费用-交通费', '销售费用-广告宣传费', '建设费用', '待确认'];

  /* ---------- 自家公司（购买方）配置 ----------
   * 全称可在设置弹窗修改，持久化到 localStorage['piaoxiaobang_settings'].myCompany
   */

  const SETTINGS_KEY = 'piaoxiaobang_settings';
  const DEFAULT_COMPANY = '浙江通途数科建设有限公司';

  function getMyCompany() {
    try {
      const raw = (typeof localStorage !== 'undefined') ? localStorage.getItem(SETTINGS_KEY) : null;
      if (raw) {
        const s = JSON.parse(raw);
        if (s.myCompany && String(s.myCompany).trim()) return String(s.myCompany).trim();
      }
    } catch (e) { /* ignore */ }
    return DEFAULT_COMPANY;
  }

  function setMyCompany(name) {
    if (!name || !String(name).trim()) return;
    try {
      const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
      s.myCompany = String(name).trim();
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
    } catch (e) { /* ignore */ }
  }

  /* ---------- 特殊情况说明 ---------- */

  function buildRemark(inv) {
    const out = [];
    const total = totalOf(inv);
    const t = inv.invoiceType || '';
    const sum = (inv.summary || '') + ' ' + (inv.seller || '');
    const isFood = CAT_FOOD.some(k => sum.includes(k));
    const isAd = CAT_AD.some(k => sum.includes(k));
    const isWelfare = CAT_WELFARE.some(k => sum.includes(k));
    const isExpress = /快递|收派|顺丰/.test(sum);
    const isPrinter = /打印|票据打|打印机/.test(sum) && !/纸|标签/.test(sum);
    const isVeg = /蔬菜/.test(sum);
    const isOffice = CAT_OFFICE.some(k => sum.includes(k)) || /办公|文具|耗材|硒鼓|墨盒/.test(sum);
    // isBuild：商品含建设关键词（如路锥/灯具/建材等）即视为建设物资采购；
    // 仅当卖家整名就是"XX设备公司/仪表公司"（明显不是建设类采购商）时排除
    const isBuild = CAT_BUILD.some(k => sum.includes(k)) && !/设备(有限|公司)|仪表(有限|公司)/.test(inv.seller || '');
    const isLowvalue = CAT_LOWVALUE.some(k => sum.includes(k));
    const isSpec = /专票/.test(t);
    const isAsset = /打印机|电脑|笔记本|台式机|服务器|空调|投影|复印机|碎纸机|保险柜|家具/.test(sum) && total >= 1000;
    const big = total >= 5000, mid = total >= 2000, small = total >= 1000;
    const yuan = (n) => { const r = round2(n); return Number.isInteger(r) ? String(r) : r.toFixed(2); };

    // 1) 特殊情况：专票、固定资产、快递、餐费、广告、福利
    if (isSpec) out.push('增值税专用发票，需附发票认证结果(抵扣联)');
    if (isAsset) out.push('固定资产(¥' + yuan(total) + ')，需附资产验收单、固定资产登记表及采购合同');
    if (isExpress) out.push('快递费，备注栏注明项目邮递资料');
    if (isFood) {
      if (big) out.push('大额餐费(¥' + yuan(total) + ')，需附菜单、就餐人员名单及业务招待事由说明');
      else out.push('餐费(¥' + yuan(total) + ')，需附菜单、就餐人员名单');
    } else if (isAd) {
      out.push('广告费(¥' + yuan(total) + ')，需附广告合同及发布证明');
    } else if (isWelfare) {
      out.push('福利费支出(¥' + yuan(total) + ')，需附发放签收表/人员名单');
    } else if (isVeg && big) {
      out.push('大额采购(¥' + yuan(total) + ')，蔬菜采购需附采购明细清单及验收单；免税发票');
    } else if (isBuild) {
      // 2) 建设物资类采购
      if (big) out.push('建设物资采购(¥' + yuan(total) + ')，需附采购合同、验收单及出入库单');
      else if (mid) out.push('建设物资采购(¥' + yuan(total) + ')，建议附采购合同及验收单');
      else if (small) out.push('建设物资采购(¥' + yuan(total) + ')，建议附验收单');
      else out.push('建设物资采购(¥' + yuan(total) + ')，保留发票及付款凭证');
    } else if (isOffice) {
      // 3) 办公用品/耗材
      if (big) out.push('办公用品采购(¥' + yuan(total) + ')，需附采购清单及验收单');
      else if (small) out.push('办公用品采购(¥' + yuan(total) + ')，保留发票及领用登记');
      else out.push('办公用品采购(¥' + yuan(total) + ')，保留发票备查');
    } else if (isLowvalue) {
      // 4) 低值易耗品
      if (mid) out.push('低值易耗品采购(¥' + yuan(total) + ')，建议附领用登记');
      else out.push('低值易耗品采购(¥' + yuan(total) + ')，保留发票及领用登记');
    } else if (big) {
      out.push('大额采购(¥' + yuan(total) + ')，需附采购合同及验收单');
    } else if (mid) {
      out.push('中额采购(¥' + yuan(total) + ')，建议附采购合同及验收单');
    } else if (small) {
      out.push('普通采购(¥' + yuan(total) + ')，建议附采购验收单');
    } else if (total > 0) {
      out.push('小额采购(¥' + yuan(total) + ')，保留发票及付款凭证备查');
    }
    // 5) 购买方非本公司提示
    const MY_COMPANY = getMyCompany();
    if (MY_COMPANY && inv.buyer && inv.buyer !== MY_COMPANY) {
      out.push('购买方为' + inv.buyer + '，非本公司，需说明费用归属关系或提供代付说明');
    }
    return out.join('；');
  }

  /* ---------- 重命名后文件名 ---------- */

  function buildNewName(inv) {
    if (!inv.number || !inv.sellerShort) return '';
    const t = inv.invoiceType || '电子普票';
    const d = formatDateCompact(inv.date);
    if (!/^\d{8}$/.test(d)) return '';
    return t + '+' + d + '+' + inv.number + '+' + inv.sellerShort + '+' + totalOf(inv).toFixed(2) + '.pdf';
  }

  /* ---------- 总入口：补充台账字段 ---------- */

  function enrichInvoice(inv, rawText, shortMap) {
    const clean = String(rawText || '').replace(/\s+/g, '');
    inv.invoiceType = inv.invoiceType || detectInvoiceType(clean);
    if (!inv.summary) inv.summary = extractSummary(rawText || '');
    if (!inv.sellerShort) {
      if (shortMap && inv.seller && shortMap[inv.seller]) {
        inv.sellerShort = shortMap[inv.seller];
      } else {
        inv.sellerShort = extractShortName(inv.seller);
      }
    }
    if (!inv.category) inv.category = classifyCategory(inv);
    if (!inv.remark) inv.remark = buildRemark(inv);
    if (!inv.newName) inv.newName = buildNewName(inv);
    return inv;
  }

  /* ---------- 14列样式 Excel 导出 ---------- */

  function buildLedgerWorkbook(ledger, title) {
    if (!ledger || ledger.length === 0) return null;
    const XLSXLib = (typeof XLSX !== 'undefined') ? XLSX : null;
    if (!XLSXLib) return null;

    const t = title || '发票台账';
    const rows = [];
    rows.push([t]);
    rows.push(['序号', '发票类型', '开票日期', '发票号码', '销售方名称', '销售方简称', '购买方名称', '商品/项目摘要', '金额(不含税)', '税额', '价税合计', '费用分类', '特殊情况说明', '重命名后文件名']);
    let sumAmt = 0, sumTax = 0, sumAll = 0;
    ledger.forEach((inv, i) => {
      const amt = round2(inv.amount);
      const tax = round2(inv.tax);
      const all = totalOf(inv);
      sumAmt += amt; sumTax += tax; sumAll += all;
      rows.push([
        i + 1,
        inv.invoiceType || '',
        formatDateDash(inv.date),
        String(inv.number || ''),
        inv.seller || '',
        inv.sellerShort || '',
        inv.buyer || '',
        inv.summary || '',
        amt, tax, all,
        inv.category || '',
        inv.remark || '',
        inv.newName || ''
      ]);
    });
    const n = ledger.length;
    rows.push(['合计', '', '', '', '', '', '', '', round2(sumAmt), round2(sumTax), round2(sumAll), '', '', '']);

    const ws = XLSXLib.utils.aoa_to_sheet(rows);
    const lastRow = rows.length - 1;

    ws['!merges'] = [
      { s: { r: 0, c: 0 }, e: { r: 0, c: 13 } },
      { s: { r: lastRow, c: 0 }, e: { r: lastRow, c: 7 } }
    ];
    ws['!cols'] = [
      { wch: 6 }, { wch: 10 }, { wch: 12 }, { wch: 22 }, { wch: 30 }, { wch: 12 },
      { wch: 25 }, { wch: 35 }, { wch: 13 }, { wch: 10 }, { wch: 12 }, { wch: 16 },
      { wch: 45 }, { wch: 35 }
    ];
    ws['!rows'] = rows.map((_, i) => ({ hpt: i === 0 ? 35 : (i === 1 ? 30 : 40) }));

    const font = (name, sz, bold) => ({ name: name || '微软雅黑', sz: sz || 10, bold: !!bold });
    const thin = { style: 'thin', color: { rgb: 'FF000000' } };
    const border = { top: thin, bottom: thin, left: thin, right: thin };
    const align = (h, v) => ({ horizontal: h, vertical: v || 'center' });

    const headerFill = { fgColor: { rgb: 'FF4472C4' }, patternType: 'solid' };
    const headerFont = { name: '微软雅黑', sz: 11, bold: true, color: { rgb: 'FFFFFFFF' } };

    for (let r = 0; r < rows.length; r++) {
      for (let c = 0; c < 14; c++) {
        const addr = XLSXLib.utils.encode_cell({ r: r, c: c });
        if (!ws[addr]) continue;
        const cell = ws[addr];
        if (r === 0) {
          cell.s = { font: { name: '微软雅黑', sz: 16, bold: true }, alignment: align('center') };
        } else if (r === 1) {
          cell.s = { font: headerFont, fill: headerFill, alignment: align('center'), border: border };
        } else {
          const isNumCol = c === 8 || c === 9 || c === 10;
          const isTextCol = c === 3 || c === 4 || c === 7 || c === 12 || c === 13;
          cell.s = {
            font: font('微软雅黑', 10, false),
            alignment: align(isNumCol || c === 0 || c === 1 || c === 2 || c === 5 || c === 6 || c === 11 ? 'center' : 'left'),
            border: border
          };
          if (isNumCol) {
            cell.z = '#,##0.00';
            cell.v = round2(cell.v);
          } else if (isTextCol) {
            cell.z = '@';
          }
          if (c === 7) cell.s.alignment.wrapText = true;
          if (c === 12) cell.s.alignment.wrapText = true;
        }
      }
    }
    const wb = XLSXLib.utils.book_new();
    XLSXLib.utils.book_append_sheet(wb, ws, t.replace(/[年月份]/g, ''));
    return wb;
  }

  const LedgerCore = {
    formatDateDash: formatDateDash,
    formatDateCompact: formatDateCompact,
    round2: round2,
    totalOf: totalOf,
    detectInvoiceType: detectInvoiceType,
    extractSummary: extractSummary,
    extractShortName: extractShortName,
    classifyCategory: classifyCategory,
    buildRemark: buildRemark,
    buildNewName: buildNewName,
    enrichInvoice: enrichInvoice,
    buildLedgerWorkbook: buildLedgerWorkbook,
    CATEGORIES: CATEGORIES,
    getMyCompany: getMyCompany,
    setMyCompany: setMyCompany,
    get MY_COMPANY() { return getMyCompany(); }
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = LedgerCore;
  else global.LedgerCore = LedgerCore;
})(typeof window !== 'undefined' ? window : globalThis);
