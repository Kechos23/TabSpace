using DragGroup.Core;
int passed=0;
void Check(bool value,string name){if(!value)throw new Exception(name);passed++;Console.WriteLine($"PASS {name}");}
void Reject(Action action,string name){try{action();}catch(InvalidOperationException){Check(true,name);return;}throw new Exception($"Expected rejection: {name}");}
var now=DateTimeOffset.UtcNow;
var tabs=new BrowserTab[]{new(1,0,true,-1,false),new(2,1,false,-1,true),new(3,2,false,-1,false),new(4,3,false,-1,false)};
var snapshot=new Snapshot(7,1,tabs);
var slots=new Slot[]{new("beacon",-350,20,50,32,false,"DG:nonce"),new("A",-300,20,100,32,false,"Same title"),new("B",-200,20,100,32,false,"Same title"),new("C",-100,20,100,32,false,"Another title")};
IdentityMap Build(Snapshot? state=null,Slot[]? geometry=null,string marker="DG:nonce")=>Mapping.Build(state??snapshot,geometry??slots,marker,now);
var map=Build();
Check(map.Bindings[1].Tab.Id==2,"duplicate labels are supported through runtime/order mapping");
Check(map.Bindings[1].Slot.X<0,"negative screen coordinates supported");
Reject(()=>Build(marker:"Wrong challenge"),"wrong profile/window challenge rejected");
Reject(()=>Build(geometry:slots[..^1]),"incomplete strip rejected");
Reject(()=>Build(geometry:slots.Select((s,i)=>i==2?s with{Offscreen=true}:s).ToArray()),"offscreen/overflow rejected");
Reject(()=>Build(geometry:slots.Select((s,i)=>i==2?s with{Y=65}:s).ToArray()),"vertical or multiple row layout rejected");
Reject(()=>Build(geometry:slots.Select((s,i)=>i==2?s with{RuntimeId="A"}:s).ToArray()),"duplicate runtime identity rejected");
Reject(()=>Build(geometry:slots.Select((s,i)=>i==2?s with{X=-295}:s).ToArray()),"ambiguous central geometry rejected");
Reject(()=>Build(snapshot with{Tabs=tabs.Select((t,i)=>i==2?t with{Id=2}:t).ToArray()}),"duplicate Chrome identity rejected");
Reject(()=>Build(snapshot with{Tabs=tabs.Select((t,i)=>i==2?t with{Index=8}:t).ToArray()}),"incomplete Chrome order rejected");
Check(Mapping.MembersMatch(map,snapshot with{Tabs=tabs.Reverse().ToArray()}),"identity membership tolerates source reordering");
Check(!Mapping.MembersMatch(map,snapshot with{WindowId=8}),"another window invalidates map");
Check(!Mapping.MembersMatch(map,snapshot with{Tabs=tabs.Select((t,i)=>i==1?t with{Pinned=true}:t).ToArray()}),"pin change invalidates map");
Check(!Mapping.MembersMatch(map,snapshot with{Tabs=tabs.Select((t,i)=>i==1?t with{GroupId=4}:t).ToArray()}),"group change invalidates map");
var moved=slots.Select(s=>s.RuntimeId=="A"?s with{X=-180}:s.RuntimeId=="B"?s with{X=-300}:s).ToArray();
Check(Mapping.ReleaseOrderMatches(map,moved,2),"only source can reorder before release");
Check(Mapping.Crossed(map.Bindings[2].Slot,moved.Single(s=>s.RuntimeId=="B"),1),"final read detects a passed target even if drag-time geometry was stale");
Check(!Mapping.Crossed(map.Bindings[2].Slot,moved.Single(s=>s.RuntimeId=="B"),-1),"crossing proof respects the actual reverse approach direction");
Check(!Mapping.ReleaseOrderMatches(map,slots.Select(s=>s.RuntimeId=="B"?s with{X=-90}:s.RuntimeId=="C"?s with{X=-200}:s).ToArray(),2),"another tab moving cancels release");
Check(!Mapping.ReleaseOrderMatches(map,slots.Select(s=>s.RuntimeId=="B"?s with{RuntimeId="new B"}:s).ToArray(),2),"runtime replacement cancels release");
Check(!Mapping.ReleaseOrderMatches(map,slots.Select(s=>s.RuntimeId=="B"?s with{Offscreen=true}:s).ToArray(),2),"overflow appearing during drag cancels release");
Check(!Mapping.ReleaseOrderMatches(map,slots.Select(s=>s with{Y=s.Y+50}).ToArray(),2),"tab strip moving vertically cancels release");
var gesture=new Gesture();
void Start(){gesture.Down(map,-250,35,now);Check(gesture.Active,"source freezes on mousedown");}
Start();gesture.Move(-150,35,now.AddMilliseconds(30));gesture.Move(-150,35,now.AddMilliseconds(280));Check(gesture.Armed,"200ms dwell arms target");Check(gesture.Release(-150,35,now.AddMilliseconds(290)) is {Source:2,Target:3},"release returns exact frozen pair");
Start();gesture.Move(-150,35,now.AddMilliseconds(30));Check(gesture.Release(-150,35,now.AddMilliseconds(100)) is null,"fast reorder never groups");
Start();gesture.Move(-150,35,now.AddMilliseconds(30));gesture.Move(-150,35,now.AddMilliseconds(700));Check(gesture.Release(-150,200,now.AddMilliseconds(750)) is null,"drop outside strip cancels");
Start();gesture.Move(-150,35,now.AddMilliseconds(30));gesture.Move(-150,35,now.AddMilliseconds(700));gesture.Cancel();Check(gesture.Release(-150,35,now.AddMilliseconds(750)) is null,"Escape/focus cancellation produces no action");
Start();gesture.Move(-150,35,now.AddMilliseconds(30));gesture.Move(-150,35,now.AddSeconds(31));Check(!gesture.Active,"30s drag timeout clears intent");
gesture.Down(map,-325,35,now);Check(!gesture.Active,"pinned controller never a source");
gesture.Down(map,-250,35,now.AddSeconds(2));Check(!gesture.Active,"stale map cannot begin a gesture");
var multi=map with{Bindings=map.Bindings.Select((b,i)=>i==2?b with{Tab=b.Tab with{Highlighted=true}}:b).ToArray()};gesture.Down(multi,-250,35,now);Check(!gesture.Active,"multi-selection rejected");
gesture.Down(map,-285,35,now);Check(gesture.Active,"regression: grab left text area without aiming at the tab centre");
gesture.Move(-185,35,now.AddMilliseconds(30));Check(gesture.Target?.Tab.Id==3,"regression: acquire neighbour before crossing its centre");
gesture.UpdateLayout(moved);gesture.Move(-185,35,now.AddMilliseconds(100));Check(gesture.Target is null&&!gesture.Armed,"a neighbour moved behind the source is passed rather than retained at its old position");
gesture.Move(-163,35,now.AddMilliseconds(120));Check(gesture.Target?.Tab.Id==4,"after native reorder the next tab acquires at slight overlap");
Check(gesture.Release(-163,35,now.AddMilliseconds(370)) is {Source:2,Target:4},"release groups the next identity rather than the passed neighbour");
gesture.Down(map,-230,35,now);Check(gesture.Active,"grab right text area outside the old middle-50-percent handle");
gesture.Down(map,-207,35,now);Check(!gesture.Active,"close-button edge is not a drag handle");
gesture.Down(map,-250,35,now);gesture.Move(-150,35,now.AddMilliseconds(30));gesture.Move(-150,35,now.AddMilliseconds(700));Check(gesture.Release(-250,35,now.AddMilliseconds(750)) is null,"returning to the source without a moved target cancels");
Check(Mapping.ReleaseOrderMatches(map,slots.Select(s=>s.RuntimeId=="A"?s with{RuntimeId="reparented-A"}:s).ToArray(),2),"dragged source view may be recreated only when all other identities survive");
Check(!Mapping.ReleaseOrderMatches(map,slots.Select(s=>s.RuntimeId=="A"?s with{RuntimeId="reparented-A"}:s.RuntimeId=="C"?s with{RuntimeId="recreated-C"}:s).ToArray(),2),"recreating any second view cancels identity proof");
foreach(double width in new double[]{36,60,100,240})
foreach(double grab in new double[]{.12,.45,.7})
foreach(int direction in new[]{-1,1})
{
    var geometry=new Slot[]{new("beacon",-50,20,50,32,false,"DG:nonce"),new("A",0,20,width,32,false,"Same"),new("B",width,20,width,32,false,"Same"),new("C",2*width,20,width,32,false,"Same")};
    var scaled=Build(geometry:geometry);
    int sourceIndex=direction==1?1:2,targetId=direction==1?3:2;
    double down=geometry[sourceIndex].X+width*grab,position=down+direction*width*.22;
    gesture.Down(scaled,down,35,now);gesture.Move(position,35,now.AddMilliseconds(20));
    Check(gesture.Target?.Tab.Id==targetId,$"22% overlap: width {width}, grab {grab}, direction {direction}");
    gesture.Move(position,35,now.AddMilliseconds(219));Check(!gesture.Armed,"199ms overlap has not armed");
    Check(gesture.Release(position,35,now.AddMilliseconds(220)) is {} intent&&intent.Target==targetId,"200ms overlap releases exact target independently of grab offset");
}
gesture.Down(map,-285,35,now);gesture.Move(-282,35,now.AddMilliseconds(500));Check(gesture.Target is null,"small click jitter never acquires a neighbour");
gesture.Down(map,-285,35,now);gesture.Move(-263,35,now.AddMilliseconds(20));Check(gesture.Target?.Tab.Id==3,"slight overlap acquires before cursor reaches neighbour");
gesture.Move(-290,35,now.AddMilliseconds(400));Check(!gesture.Armed&&gesture.Target is null,"backing out below overlap hysteresis cancels");
gesture.Down(map,-285,35,now);gesture.Move(-263,35,now.AddMilliseconds(20));Check(gesture.Release(-263,100,now.AddMilliseconds(400)) is null,"vertical detachment cancels overlap gesture");
foreach(var (sourceWidth,targetWidth) in new[]{(240d,60d),(60d,240d)})
{
    var unequal=new Slot[]{new("beacon",-50,20,50,32,false,"DG:nonce"),new("A",0,20,sourceWidth,32,false,"A"),new("B",sourceWidth,20,targetWidth,32,false,"B"),new("C",sourceWidth+targetWidth,20,100,32,false,"C")};
    var resized=Build(geometry:unequal);double start=sourceWidth*.12,finish=start+Math.Min(sourceWidth,targetWidth)*.22;
    gesture.Down(resized,start,35,now);gesture.Move(finish,35,now.AddMilliseconds(20));
    Check(gesture.Release(finish,35,now.AddMilliseconds(370)) is {Target:3},"unequal current tab widths use the narrower width for overlap");
}
foreach(double width in new double[]{36,100,240})
foreach(int direction in new[]{-1,1})
foreach(bool reordered in new[]{false,true})
{
    var geometry=new Slot[]{new("beacon",-50,20,50,32,false,"DG:nonce"),new("A",0,20,width,32,false,"A"),new("B",width,20,width,32,false,"B"),new("C",2*width,20,width,32,false,"C")};
    var state=Build(geometry:geometry);int sourceIndex=direction==1?1:2,targetIndex=direction==1?2:1;
    double down=geometry[sourceIndex].X+width*.45,peak=down+direction*width*.6;
    double threshold=Math.Clamp(width*.05,3,10);
    gesture.Down(state,down,35,now);gesture.Move(peak,35,now.AddMilliseconds(20));gesture.Move(peak,35,now.AddMilliseconds(220));
    Check(gesture.Armed,$"retreat fixture armed: width {width}, direction {direction}, reordered {reordered}");
    if(reordered){
        gesture.UpdateLayout(geometry.Select((slot,index)=>index==sourceIndex?slot with{X=geometry[targetIndex].X}:index==targetIndex?slot with{X=geometry[sourceIndex].X}:slot).ToArray());
        Check(gesture.Target is null&&!gesture.Armed,"native crossing clears even an already armed target");
        Check(gesture.Release(peak,35,now.AddMilliseconds(500)) is null,"release after native crossing cannot group the passed target");
        continue;
    }
    gesture.Move(peak-direction*threshold*.5,35,now.AddMilliseconds(280));Check(gesture.Armed,"sub-threshold hand jitter preserves grouping");
    double withdrawn=peak-direction*(threshold+1);
    gesture.Move(withdrawn,35,now.AddMilliseconds(290));Check(gesture.Target is null&&!gesture.Armed&&gesture.Progress==0,"small reverse movement cancels despite substantial overlap");
    gesture.Move(withdrawn,35,now.AddMilliseconds(600));Check(gesture.Target is null,"holding after cancellation cannot silently rearm");
    Check(gesture.Release(withdrawn,35,now.AddMilliseconds(700)) is null,"releasing after short retreat never creates a group");
    gesture.Down(state,down,35,now);gesture.Move(peak,35,now.AddMilliseconds(20));gesture.Move(withdrawn,35,now.AddMilliseconds(30));
    gesture.Move(peak,35,now.AddMilliseconds(100));Check(gesture.Target?.Tab.Id==state.Bindings[targetIndex].Tab.Id&&!gesture.Armed,"moving towards target again starts a fresh dwell");
    gesture.Move(peak,35,now.AddMilliseconds(299));Check(!gesture.Armed,"reacquisition does not reuse previous dwell");
    Check(gesture.Release(peak,35,now.AddMilliseconds(300)) is not null,"intentional approach and fresh dwell can group again");
}
foreach(double width in new double[]{36,100,240})
foreach(int direction in new[]{-1,1})
foreach(bool reordered in new[]{false,true})
{
    var geometry=new List<Slot>{new("beacon",-50,20,50,32,false,"DG:nonce")};
    var stateTabs=new List<BrowserTab>{new(1,0,true,-1,false)};
    for(int index=0;index<7;index++){
        geometry.Add(new($"tab-{index}",index*width,20,width,32,false,"Same title"));
        stateTabs.Add(new(index+2,index+1,false,-1,index==(direction==1?0:6)));
    }
    var state=Build(new(7,1,stateTabs.ToArray()),geometry.ToArray());
    int sourcePosition=direction==1?0:6;double down=sourcePosition*width+width*.45;
    gesture.Down(state,down,35,now);
    double position=down;
    for(int step=1;step<=5;step++){
        position=down+direction*(step-(reordered&&step==5?.78:.4))*width;
        gesture.Move(position,35,now.AddMilliseconds(step*20));
        int expected=sourcePosition+direction*step;
        Check(gesture.Target?.Tab.Id==expected+2,$"pass-through selects next dominant tab: width {width}, direction {direction}, step {step}, reorder {reordered}");
        Check(!gesture.Armed,"each newly passed target starts its own dwell");
        if(reordered&&step<5){
            var layout=geometry.Select((slot,index)=>{
                int original=index-1;if(original<0)return slot;
                if(original==sourcePosition)return slot with{X=(sourcePosition+direction*step)*width};
                bool crossed=direction==1?original>sourcePosition&&original<=sourcePosition+step:original<sourcePosition&&original>=sourcePosition-step;
                return crossed?slot with{X=slot.X-direction*width}:slot;
            }).ToArray();
            gesture.UpdateLayout(layout);
            Check(gesture.Target is null,"each crossed neighbour is cleared by its new runtime geometry");
            gesture.Move(position,35,now.AddMilliseconds(step*20+1));
            Check(gesture.Target is null,"a stationary tick cannot reacquire a crossed neighbour from its old rectangle");
            Check(Mapping.ReleaseOrderMatches(state,layout,sourcePosition+2),"passing multiple tabs preserves non-source identity order");
        }
    }
    gesture.Move(position,35,now.AddMilliseconds(299));Check(!gesture.Armed,"previous targets cannot donate their dwell to the final target");
    Check(gesture.Release(position,35,now.AddMilliseconds(300)) is {} result&&result.Target==sourcePosition+direction*5+2,"release groups the distant final target after its own dwell");
}
gesture.Down(map,-250,35,now);gesture.Move(-190,35,now.AddMilliseconds(20));gesture.Move(-190,35,now.AddMilliseconds(220));
Check(gesture.Armed&&gesture.Target?.Tab.Id==3,"intermediate target can be armed before continuing past it");
gesture.Move(-90,35,now.AddMilliseconds(280));Check(gesture.Target?.Tab.Id==4&&!gesture.Armed&&gesture.Progress==0,"passing an already armed target resets readiness for the new one");
Check(gesture.Release(-90,35,now.AddMilliseconds(300)) is null,"fast release over the next tab cannot group the previous armed target");
{
    var wide=Build(geometry:new Slot[]{new("beacon",-50,20,50,32,false,"DG:nonce"),new("A",0,20,240,32,false,"Same"),new("B",240,20,60,32,false,"Same"),new("C",300,20,60,32,false,"Same")});
    gesture.Down(wide,30,35,now);gesture.Move(210,35,now.AddMilliseconds(20));Check(gesture.Target is null,"equal coverage and distance without a prior target never guesses an identity");
    Check(gesture.Release(210,35,now.AddMilliseconds(300)) is null,"ambiguous simultaneous candidates cannot create a group");
    gesture.Down(wide,30,35,now);gesture.Move(180,35,now.AddMilliseconds(20));Check(gesture.Target?.Tab.Id==3,"wide source can select a fully overlapped narrow target");
    gesture.Move(210,35,now.AddMilliseconds(25));Check(gesture.Target?.Tab.Id==3,"an exact transition tie retains the existing target without flicker");
    gesture.Move(240,35,now.AddMilliseconds(30));Check(gesture.Target?.Tab.Id==4,"nearest centre selects the next narrow target despite equal full coverage");
}
{
    var geometry=new Slot[]{new("beacon",-50,20,50,32,false,"DG:nonce"),new("A",0,20,240,32,false,"Same"),new("B",240,20,60,32,false,"Same"),new("C",300,20,60,32,false,"Same"),new("D",360,20,60,32,false,"Same")};
    var state=Build(new(7,1,new BrowserTab[]{new(1,0,true,-1,false),new(2,1,false,-1,true),new(3,2,false,-1,false),new(4,3,false,-1,false),new(5,4,false,-1,false)}),geometry);
    gesture.Down(state,30,35,now);gesture.Move(180,35,now.AddMilliseconds(20));gesture.Move(180,35,now.AddMilliseconds(220));Check(gesture.Armed,"wide source arms an unambiguous initial target");
    gesture.Move(270,35,now.AddMilliseconds(280));Check(gesture.Target is null&&!gesture.Armed,"two stronger tied later targets clear an armed passed neighbour");
    Check(gesture.Release(270,35,now.AddMilliseconds(600)) is null,"ambiguous later coverage cannot release the old armed target");
}
{
    var geometry=new[]{new Slot("beacon",-50,20,50,32,false,"DG:nonce"),new("A",0,20,100,32,false,"Same"),new("B",100,20,100,32,false,"Same"),new("C",200,20,100,32,false,"Same"),new("D",300,20,100,32,false,"Same")};
    var state=Build(new(7,1,new BrowserTab[]{new(1,0,true,-1,false),new(2,1,false,-1,true),new(3,2,false,-1,false),new(4,3,false,-1,false),new(5,4,false,-1,false)}),geometry);
    gesture.Down(state,45,35,now);gesture.Move(345,35,now.AddMilliseconds(20));gesture.Move(345,35,now.AddMilliseconds(220));
    gesture.Move(335,35,now.AddMilliseconds(280));Check(gesture.Target is null,"turning back from a distant tab still cancels promptly");
    gesture.Move(245,35,now.AddMilliseconds(300));Check(gesture.Target?.Tab.Id==4,"continuing back can acquire a different intermediate tab");
    gesture.Move(235,35,now.AddMilliseconds(310));Check(gesture.Target?.Tab.Id==4,"new target follows the actual approach direction after reversing");
    Check(gesture.Release(235,35,now.AddMilliseconds(550)) is {Target:4},"retracing then dwelling groups the intended intermediate identity");
}
foreach(double screenTop in new double[]{0,-1080})
foreach(double height in new double[]{32,48,64})
foreach(double gap in new double[]{0,2,8})
{
    var geometry=slots.Select(s=>s with{Y=screenTop+gap,Height=height}).ToArray();
    var edgeMap=Build(geometry:geometry);
    gesture.Down(edgeMap,-250,screenTop,now,screenTop);
    Check(gesture.Source?.Tab.Id==2,"maximized monitor top edge captures the exact source across DPI and negative coordinates");
    gesture.Move(-190,screenTop,now.AddMilliseconds(20));
    Check(gesture.Release(-190,screenTop,now.AddMilliseconds(220)) is {Source:2,Target:3},"drag and release along the screen top preserve grouping");
    Check(Mapping.SourceHit(edgeMap,-250,screenTop-.1,screenTop) is null,"above the real monitor edge is not accepted");
    Check(Mapping.SourceHit(edgeMap,-250,screenTop) is null,"normal windows do not extend through their title-bar padding");
    gesture.Down(edgeMap,-325,screenTop,now,screenTop);Check(!gesture.Active,"controller stays excluded at the monitor edge");
    Check(Mapping.SourceHit(edgeMap,-202,screenTop,screenTop) is null,"close-button exclusion remains at the top edge");
}
Check(Mapping.SourceHit(map,-250,0,0) is null,"an unrelated monitor edge far above the tab row is not accepted");
var activation=new ActivationGate();
Check(activation.Check(true,now)==ActivationState.Rejected,"activation cannot start without a captured down");
activation.Begin(false,now);Check(activation.Check(false,now.AddMilliseconds(16))==ActivationState.Waiting,"initial mouse down may precede Chrome activation");
Check(activation.Check(true,now.AddMilliseconds(80))==ActivationState.Ready,"first click resumes when Chrome activates");
Check(activation.Check(false,now.AddMilliseconds(90))==ActivationState.Rejected,"focus loss after activation cancels without a grace period");
activation.Begin(false,now);Check(activation.Check(false,now.AddMilliseconds(200))==ActivationState.Rejected,"an app that never activates times out");
activation.Begin(false,now);Check(activation.Check(true,now.AddMilliseconds(200))==ActivationState.Rejected,"late activation cannot resurrect a timed-out down");
activation.Reset();Check(activation.Check(true,now)==ActivationState.Rejected,"cancel or release clears pending activation");
gesture.Down(map,-285,30,now);gesture.Move(-263,32,now.AddMilliseconds(20));
Check(gesture.SourceSlot is {X:-278,Y:20}&&gesture.TargetSlot is {X:-200},"source visual follows horizontal grab offset and stays on the target row");
foreach(double pointerY in new[]{24d,36d}){
    gesture.Move(-263,pointerY,now.AddMilliseconds(40));
    Check(gesture.SourceSlot is {X:-278,Y:20}&&gesture.TargetSlot is {Y:20},"vertical pointer movement does not move either tab outline off the strip");
}
gesture.Cancel();Check(gesture.SourceSlot is null&&gesture.TargetSlot is null,"cancel removes both visual bounds");
Console.WriteLine($"{passed} native mapping and gesture assertions passed. These are pure fixtures, not real desktop acceptance.");

foreach(double width in new[]{36d,100d,240d})
foreach(double grab in new[]{.12,.45,.7})
foreach(int direction in new[]{-1,1})
{
 var geometry=new Slot[]{new("beacon",-50,20,50,32,false,"DG:nonce"),new("A",0,20,width,32,false,"A"),new("B",width,20,width,32,false,"B"),new("C",2*width,20,width,32,false,"C")};
 var state=Build(geometry:geometry);int sourceIndex=direction==1?1:2,targetId=direction==1?3:2;
 double down=geometry[sourceIndex].X+width*grab;
 gesture.Down(state,down,35,now);
 gesture.Move(down+direction*width*.159,35,now.AddMilliseconds(10));Check(gesture.Target is null,"15.9% does not acquire a target");
 double position=down+direction*width*.161;
 gesture.Move(position,35,now.AddMilliseconds(20));Check(gesture.Target?.Tab.Id==targetId,"16.1% acquires across grab offsets, widths and directions");
 gesture.Move(position,35,now.AddMilliseconds(219));Check(!gesture.Armed,"199ms is not ready");
 Check(gesture.Release(position,35,now.AddMilliseconds(220)) is { } result&&result.Target==targetId,"200ms is ready at the new overlap boundary");
}
Console.WriteLine($"{passed} assertions including new 16%/200ms boundaries passed.");

gesture.Down(map,-285,35,now);gesture.Move(-263,35,now.AddMilliseconds(20));
gesture.Move(-263,35,now.AddMilliseconds(29999));Check(gesture.Active&&gesture.Armed,"continuous hold remains armed just before 30 seconds");
Check(gesture.Release(-263,35,now.AddMilliseconds(30000)) is {Target:3},"release at 30 seconds preserves intended pair");
gesture.Down(map,-285,35,now);gesture.Move(-263,35,now.AddMilliseconds(20));gesture.Move(-263,35,now.AddMilliseconds(30001));
Check(!gesture.Active&&!gesture.Armed&&gesture.Target is null,"hold beyond 30 seconds clears all feedback eligibility");
gesture.Down(map,-285,35,now);
for(int attempt=0;attempt<30;attempt++){
 int at=attempt*900;
 gesture.Move(-263,35,now.AddMilliseconds(at+20));gesture.Move(-263,35,now.AddMilliseconds(at+220));
 Check(gesture.Armed,"repeated attempt can arm within the same held drag");
 gesture.Move(-270,35,now.AddMilliseconds(at+230));Check(!gesture.Armed&&gesture.Target is null,"repeated reverse cancellation clears target immediately");
 gesture.Move(-270,35,now.AddMilliseconds(at+400));Check(!gesture.Armed&&gesture.Target is null,"cancelled attempt does not reappear while stationary");
}
Console.WriteLine($"{passed} assertions including long holds and repeated cancellation passed.");

gesture.Down(map,-285,35,now);gesture.Move(-263,35,now.AddMilliseconds(20));gesture.Move(-263,35,now.AddMilliseconds(220));
var beforeProjection=gesture.SourceSlot;var beforeTarget=gesture.Target;var beforeProgress=gesture.Progress;
Check(gesture.VisualSourceAt(-260) is {X:-275,Y:20},"presentation uses a fresh horizontal sample between input ticks");
Check(gesture.SourceSlot==beforeProjection&&gesture.Target==beforeTarget&&gesture.Progress==beforeProgress&&gesture.Armed,"presentation sampling cannot mutate grouping state");
Check(gesture.VisualSourceAt(double.NaN) is null&&gesture.VisualSourceAt(double.PositiveInfinity) is null,"invalid presentation coordinates produce no visual");
Check(gesture.Release(-263,35,now.AddMilliseconds(221)) is {Target:3},"presentation sampling leaves the original release decision intact");
Check(gesture.VisualSourceAt(-260) is null,"cancelled presentation never resurrects an old source");
Console.WriteLine($"{passed} assertions including visual-only frame sampling passed.");
