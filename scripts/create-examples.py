"""Rebuild synthetic examples only; never imports real diploma components."""
import json
from pathlib import Path
out=Path(__file__).resolve().parent.parent/'examples'
out.mkdir(exist_ok=True)
def write(name,value): (out/name).write_text(json.dumps(value,ensure_ascii=False,indent=2)+'\n')
def p(kind,**kw):return dict(id='g'+str(p.i),kind=kind,**kw)
p.i=0
def graphics(*items):
 for i,x in enumerate(items): x['id']='g'+str(i)
 return list(items)
def pin(n,x,y,side):return dict(number=str(n),x=x,y=y,side=side)
def section(sid,g,pins):return dict(section_id=sid,graphics=g,pins=pins)
def comp(code,name,prefix,sections,cat='Типовые УГО'):
 nums=list(dict.fromkeys(p['number'] for s in sections for p in s['pins']))
 return dict(format_version='1.0',component_code=code,name=name,category=cat,positional_prefix=prefix,physical_pins=[dict(number=n) for n in nums],variants=[dict(variant_code='01',name='Основной',sections=sections)])
ends=[pin(1,-5,2.5,'left'),pin(2,15,2.5,'right')]
r=comp('GEN_R','Резистор — универсальный шаблон','R',[section('BODY',graphics(p('rectangle',x=0,y=0,width=10,height=5)),ends)])
c=comp('GEN_C','Конденсатор — универсальный шаблон','C',[section('BODY',graphics(p('line',x=4,y=-1,x2=4,y2=6),p('line',x=6,y=-1,x2=6,y2=6),p('line',x=0,y=2.5,x2=4,y2=2.5),p('line',x=6,y=2.5,x2=10,y2=2.5)),ends)])
l=comp('GEN_L','Индуктивность — универсальный шаблон','L',[section('BODY',graphics(*[p('arc',x=x,y=2.5,r=1.25,start=180,end=360) for x in [1.25,3.75,6.25,8.75]]),ends)])
d=comp('GEN_D','Диод — условный тестовый символ','VD',[section('BODY',graphics(p('polygon',points=[dict(x=2,y=-1),dict(x=2,y=6),dict(x=8,y=2.5)]),p('line',x=8,y=-1,x2=8,y2=6),p('line',x=0,y=2.5,x2=2,y2=2.5),p('line',x=8,y=2.5,x2=10,y2=2.5)),ends)])
sw=comp('GEN_SWITCH','Контакт — тестовый символ','SA',[section('BODY',graphics(p('line',x=0,y=2.5,x2=8,y2=-1),p('circle',x=0,y=2.5,r=.7),p('circle',x=10,y=2.5,r=.7)),ends)])
conn=comp('DEMO_CONNECTOR','Разъём на 4 контакта — синтетический','X',[section('BODY',graphics(p('rectangle',x=0,y=0,width=10,height=25)),[pin(i,-5,i*5,'left') for i in range(1,5)])])
source=comp('DEMO_SOURCE','Источник — синтетический','G',[section('BODY',graphics(p('circle',x=5,y=5,r=5),p('line',x=3,y=3,x2=7,y2=3),p('line',x=5,y=1,x2=5,y2=5),p('line',x=3,y=7,x2=7,y2=7)),[pin(1,5,-5,'top'),pin(2,5,15,'bottom')])])
trans=comp('DEMO_TRANSISTOR','Транзистор — синтетическое УГО','VT',[section('BODY',graphics(p('circle',x=8,y=8,r=8),p('line',x=4,y=3,x2=4,y2=13),p('line',x=0,y=8,x2=4,y2=8),p('line',x=4,y=6,x2=12,y2=1),p('line',x=4,y=10,x2=12,y2=15),p('polygon',points=[dict(x=9,y=14),dict(x=12,y=15),dict(x=10,y=12)])),[pin(1,-5,8,'left'),pin(2,12,-4,'top'),pin(3,12,20,'bottom')])])
body=section('BODY',graphics(p('rectangle',x=0,y=0,width=30,height=35),p('text',x=15,y=6,text='DEMO',align='center')),[pin(1,-5,10,'left'),pin(2,-5,15,'left'),pin(3,35,10,'right'),pin(4,15,-5,'top'),pin(5,-5,20,'left'),pin(6,-5,25,'left'),pin(7,35,25,'right'),pin(8,15,40,'bottom')])
ic=comp('DEMO_IC','Двухсекционная микросхема — вымышленная','DA',[body],'Синтетические микросхемы')
ic['variants'].append(dict(variant_code='02',name='Разнесённые A / B / питание',sections=[section('A',graphics(p('rectangle',x=0,y=0,width=25,height=20),p('text',x=12.5,y=6,text='A',align='center')),[pin(1,-5,7.5,'left'),pin(2,-5,12.5,'left'),pin(3,30,10,'right')]),section('B',graphics(p('rectangle',x=0,y=0,width=25,height=20),p('text',x=12.5,y=6,text='B',align='center')),[pin(5,-5,7.5,'left'),pin(6,-5,12.5,'left'),pin(7,30,10,'right')]),section('POWER',graphics(p('rectangle',x=0,y=0,width=25,height=16),p('text',x=12.5,y=7,text='Питание',align='center')),[pin(4,12.5,-5,'top'),pin(8,12.5,21,'bottom')])]));
write('library.json',[r,c,l,d,sw,conn,source,trans,ic]);write('component_multisection.json',ic);write('component_resistor.json',r)
def instance(id,code,variant='01',value=None,**sections):
 obj=dict(id=id,component_code=code,variant_code=variant,sections=sections)
 if value:obj['value']=value
 return obj
def pos(x,y,sheet='sheet_1'):return dict(sheet_id=sheet,position=dict(x=x,y=y),locked=True)
def net(id,pins,render='wire',**kw):return dict(id=id,render=render,pins=[dict(instance_id=a,number=str(b)) for a,b in pins],**kw)
s=dict(format_version='1.0',document=dict(title='Демонстрационный тракт',designation='DEMO.0001.Э3',author='Тестовый пример',organization='Схематрон'),sheets=[dict(id='sheet_1',title='Сигнал'),dict(id='sheet_2',title='Питание')],groups=[],components=[instance('r_input','GEN_R',value='10 кОм',BODY=pos(60,65)),instance('amp','DEMO_IC','02',A=pos(125,65),B=pos(245,65),POWER=pos(90,70,'sheet_2')),instance('c_feedback','GEN_C',value='100 нФ',BODY=pos(190,125))],nets=[net('INPUT',[('r_input',1)],'label',name='Вход'),net('SIGNAL',[('r_input',2),('amp',2)]),net('OUTPUT',[('amp',3),('amp',6)],'auto'),net('FEEDBACK',[('amp',1),('c_feedback',1)]),net('RETURN',[('c_feedback',2),('amp',5)],'auto'),net('VCC',[('amp',4)],'label',name='+5 В',role='positive_supply'),net('GND',[('amp',8)],'label',name='Общий',role='ground'),net('OUT',[('amp',7)],'label',name='Выход')],layout=dict(mode='mixed',unit='mm',routes=[],labels=[]))
write('demo.json',s)
auto=json.loads(json.dumps(s));auto['sheets']=[dict(id='sheet_1')];auto['document']['title']='Автоматическая компоновка';
for obj in auto['components']: obj['tag']='Сигнальный тракт';obj['sections']={}
write('auto.json',auto)
rep=dict(format_version='1.0',document=dict(title='Три независимых RC-каскада',designation='DEMO.0002.Э3'),sheets=[dict(id='sheet_1')],groups=[],components=[instance('connector','DEMO_CONNECTOR')],nets=[net('COMMON',[('connector',1)],'label',name='Общая цепь')],templates=[dict(id='RC',components=[instance('r','GEN_R',value='10 кОм'),instance('c','GEN_C',value='100 нФ')],nets=[net('LOCAL',[('r',2),('c',1)])],ports=dict(common=[dict(instance_id='c',number='2')]))],repeat_instances=[dict(id='channel',template_id='RC',count=3,connections=dict(common='COMMON'))],layout=dict(mode='mixed',unit='mm',routes=[]))
write('repeated.json',rep)
bad=json.loads(json.dumps(s));bad['nets'][0]['pins'][0]['number']='999';write('invalid_pin.json',bad)
