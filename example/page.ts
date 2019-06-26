import { ViewController, obx, inject } from '@ali/recore';
import ChargeChart from '../../components/charge-chart';
import MonthCharge from '../../components/month-charge';

import { Icon, Tooltip } from 'uxcore';
import { NumberInfo } from '@ali/inner-uxcore';

import chargeDataApi from '../../api/chargedata.api';
import { ChargeData, Statics } from '../../api/chargedata.type';

interface Student {
  name: string;age: number;
}

@inject({
        components: { ChargeChart,MonthCharge, 
        Icon, Tooltip, 
        NumberInfo },
})
export default class Home extends ViewController {
  /** 用电量柱状图表数据 */
    @obx.ref chargeData: ChargeData[] = [];
  @obx.ref statistics: Statics = { users: 0, total: 0, month: 0, average: 0 };
  private std: Student = {name: 'xsx', age: 16};

  async $didMount() {
    this.fetchPipeChar();
    this.fetchStatistics();
    console.log(this.std.name);
  }

  public fetchPipeChar = async () => {
    try {
    const resp = await chargeDataApi.getChargeData('zhangsan', 2019);
        this.chargeData = resp.chart;
    } catch (e) {
      console.error('获取数据出错', e);
    }
  };

  fetchStatistics = async() => {
    const resp = await chargeDataApi.getStatistics('1', 1234);
    this.statistics = resp;
  };
}
